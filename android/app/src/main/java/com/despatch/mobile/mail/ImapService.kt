package com.despatch.mobile.mail

import jakarta.mail.FetchProfile
import jakarta.mail.Flags
import jakarta.mail.Folder
import jakarta.mail.Message
import jakarta.mail.Store
import jakarta.mail.UIDFolder
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeMessage
import org.eclipse.angus.mail.imap.IMAPFolder
import org.eclipse.angus.mail.imap.IMAPMessage
import org.eclipse.angus.mail.imap.IMAPStore
import org.eclipse.angus.mail.imap.protocol.IMAPProtocol
import org.eclipse.angus.mail.imap.protocol.Status
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap

fun interface PasswordSource {
    fun passwordFor(accountId: String): String?
}

/**
 * IMAP operations for any number of accounts. One connection is kept per
 * account and reused while its settings are unchanged; operations on the same
 * account run one at a time.
 */
class ImapService(private val passwords: PasswordSource) {
    private class Connection(val config: ServerConfig, val store: IMAPStore)

    private val connections = ConcurrentHashMap<String, Connection>()
    private val locks = ConcurrentHashMap<String, Mutex>()

    /** Capabilities worth knowing about for sync and features. */
    private val interestingCapabilities = listOf(
        "IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE",
        "ENABLE", "UTF8=ACCEPT", "COMPRESS=DEFLATE", "X-GM-EXT-1",
    )

    // --- Connection management -------------------------------------------------------------

    /** Connects with the given (or stored) password and reports server capabilities, without caching. */
    suspend fun test(account: AccountConfig, password: String?): List<String> = withContext(Dispatchers.IO) {
        val store = connect(account, password)
        try {
            capabilities(store)
        } finally {
            closeQuietly(store)
        }
    }

    fun disconnect(accountId: String) {
        connections.remove(accountId)?.let { closeQuietly(it.store) }
    }

    fun disconnectAll() {
        connections.keys.toList().forEach(::disconnect)
    }

    private suspend fun <T> withStore(account: AccountConfig, block: (IMAPStore) -> T): T =
        withContext(Dispatchers.IO) {
            locks.getOrPut(account.id) { Mutex() }.withLock {
                try {
                    block(storeFor(account))
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    if (!MailErrors.isStaleConnection(error)) throw MailErrors.classify(error)
                    // The cached connection died (network change, server timeout): reconnect once.
                    disconnect(account.id)
                    try {
                        block(storeFor(account))
                    } catch (retryError: Throwable) {
                        throw MailErrors.classify(retryError)
                    }
                }
            }
        }

    private fun storeFor(account: AccountConfig): IMAPStore {
        connections[account.id]?.let { existing ->
            if (existing.config == account.imap && existing.store.isConnected) return existing.store
            disconnect(account.id)
        }
        val store = connect(account, null)
        connections[account.id] = Connection(account.imap, store)
        return store
    }

    private fun connect(account: AccountConfig, password: String?): IMAPStore {
        val secret = password ?: passwords.passwordFor(account.id)
            ?: throw MailException(MailErrorCode.NO_CREDENTIALS, "No password is stored for this account.")
        val config = account.imap
        try {
            val session = MailSessions.imap(config)
            val store = session.getStore(MailSessions.imapProtocol(config)) as IMAPStore
            store.connect(config.host, config.port, config.username, secret)
            return store
        } catch (error: Throwable) {
            throw MailErrors.classify(error)
        }
    }

    private fun capabilities(store: IMAPStore) = interestingCapabilities.filter { store.hasCapability(it) }

    private fun closeQuietly(store: Store) {
        try {
            store.close()
        } catch (_: Exception) {
        }
    }

    // --- Folders ---------------------------------------------------------------------------

    suspend fun listFolders(account: AccountConfig): List<FolderInfo> = withStore(account) { store ->
        val all = store.defaultFolder.list("*").map { it as IMAPFolder }
        val subscribed = store.defaultFolder.listSubscribed("*").map { it.fullName }.toSet()
        val roles = FolderRoles.assign(
            all.map { FolderRoles.Candidate(it.fullName, it.name, it.attributes.orEmpty().toList()) },
        )
        all.map { folder ->
            val attributes = folder.attributes.orEmpty().toList()
            FolderInfo(
                path = folder.fullName,
                name = folder.name,
                delimiter = folder.separator.takeIf { it != '\u0000' }?.toString(),
                role = roles[folder.fullName],
                attributes = attributes,
                subscribed = folder.fullName in subscribed || folder.fullName.equals("INBOX", true),
                selectable = attributes.none { it.equals("\\Noselect", true) || it.equals("\\NonExistent", true) },
            )
        }
    }

    suspend fun folderStatus(account: AccountConfig, path: String): FolderStatus = withStore(account) { store ->
        val folder = existingFolder(store, path)
        val items = mutableListOf("MESSAGES", "UIDNEXT", "UIDVALIDITY", "UNSEEN")
        val condstore = store.hasCapability("CONDSTORE")
        if (condstore) items += "HIGHESTMODSEQ"
        // One STATUS round trip instead of one per value.
        val status = folder.doCommand { protocol: IMAPProtocol ->
            protocol.status(folder.fullName, items.toTypedArray())
        } as Status
        FolderStatus(
            path = path,
            uidValidity = status.uidvalidity,
            uidNext = status.uidnext,
            highestModSeq = if (condstore) status.highestmodseq else null,
            messages = status.total,
            unseen = status.unseen,
        )
    }

    // --- Messages --------------------------------------------------------------------------

    suspend fun fetchEnvelopes(account: AccountConfig, path: String, query: MessageQuery): List<Envelope> =
        withFolder(account, path, Folder.READ_ONLY) { folder ->
            val messages = select(folder, query)
            folder.fetch(messages, FetchProfile().apply {
                add(FetchProfile.Item.ENVELOPE)
                add(FetchProfile.Item.FLAGS)
                add(FetchProfile.Item.CONTENT_INFO)
                add(FetchProfile.Item.SIZE)
                add(UIDFolder.FetchProfileItem.UID)
                add("References")
            })
            messages.map { envelopeOf(folder, it as IMAPMessage) }.sortedBy { it.uid }
        }

    suspend fun fetchFlags(account: AccountConfig, path: String, query: MessageQuery): List<MessageFlags> =
        withFolder(account, path, Folder.READ_ONLY) { folder ->
            val messages = select(folder, query)
            folder.fetch(messages, FetchProfile().apply {
                add(FetchProfile.Item.FLAGS)
                add(UIDFolder.FetchProfileItem.UID)
            })
            messages.map { MessageFlags(folder.getUID(it), flagNames(it.flags)) }.sortedBy { it.uid }
        }

    suspend fun fetchBody(account: AccountConfig, path: String, uid: Long): MessageBody =
        withFolder(account, path, Folder.READ_ONLY) { folder ->
            val message = messageByUid(folder, uid)
            val leaves = MimeParts.leaves(message)
            MessageBody(
                uid = uid,
                text = leaves.firstOrNull { it.kind == MimeParts.Kind.TEXT_BODY }?.let { MimeParts.textOf(it.part) },
                html = leaves.firstOrNull { it.kind == MimeParts.Kind.HTML_BODY }?.let { MimeParts.textOf(it.part) },
                attachments = leaves
                    .filter { it.kind == MimeParts.Kind.ATTACHMENT || it.kind == MimeParts.Kind.INLINE }
                    .map(MimeParts::attachmentInfo),
            )
        }

    /** Streams one part to [destination] and returns the number of bytes written. */
    suspend fun downloadPart(
        account: AccountConfig,
        path: String,
        uid: Long,
        partId: String,
        destination: File,
    ): Long = withFolder(account, path, Folder.READ_ONLY) { folder ->
        val part = MimeParts.find(messageByUid(folder, uid), partId)
            ?: throw MailException(MailErrorCode.MESSAGE_NOT_FOUND, "Attachment $partId not found.")
        destination.parentFile?.mkdirs()
        part.inputStream.use { input -> destination.outputStream().use { input.copyTo(it) } }
    }

    suspend fun setFlags(
        account: AccountConfig,
        path: String,
        uids: List<Long>,
        add: List<String>,
        remove: List<String>,
    ) = withFolder(account, path, Folder.READ_WRITE) { folder ->
        val messages = folder.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
        if (messages.isEmpty()) return@withFolder
        if (add.isNotEmpty()) folder.setFlags(messages, flagsOf(add), true)
        if (remove.isNotEmpty()) folder.setFlags(messages, flagsOf(remove), false)
    }

    /**
     * Moves messages and returns their new UIDs in the destination (null where
     * the server doesn't report them, i.e. without UIDPLUS).
     */
    suspend fun moveMessages(
        account: AccountConfig,
        path: String,
        uids: List<Long>,
        destinationPath: String,
    ): List<Long?> = withFolder(account, path, Folder.READ_WRITE) { folder ->
        val destination = existingFolder(folder.store as IMAPStore, destinationPath)
        val messages = folder.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
        if (messages.isEmpty()) return@withFolder emptyList()

        val store = folder.store as IMAPStore
        val results = if (store.hasCapability("MOVE")) {
            folder.moveUIDMessages(messages, destination)
        } else {
            val copied = folder.copyUIDMessages(messages, destination)
            folder.setFlags(messages, Flags(Flags.Flag.DELETED), true)
            // Uses UID EXPUNGE with UIDPLUS so other \Deleted messages are left alone.
            if (store.hasCapability("UIDPLUS")) folder.expunge(messages) else folder.expunge()
            copied
        }
        List(messages.size) { index -> results?.getOrNull(index)?.uid }
    }

    /**
     * Permanently deletes messages: sets \Deleted and expunges. With UIDPLUS only
     * these UIDs are expunged; without it, other \Deleted messages in the folder go too.
     */
    suspend fun deleteMessages(account: AccountConfig, path: String, uids: List<Long>) =
        withFolder(account, path, Folder.READ_WRITE) { folder ->
            val messages = folder.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
            if (messages.isEmpty()) return@withFolder
            folder.setFlags(messages, Flags(Flags.Flag.DELETED), true)
            val store = folder.store as IMAPStore
            if (store.hasCapability("UIDPLUS")) folder.expunge(messages) else folder.expunge()
        }

    /** Appends a message (e.g. to Sent or Drafts) and returns its UID when the server reports it. */
    suspend fun append(account: AccountConfig, path: String, message: MimeMessage, flags: List<String>): Long? =
        withStore(account) { store ->
            val folder = existingFolder(store, path)
            if (flags.isNotEmpty()) message.setFlags(flagsOf(flags), true)
            folder.appendUIDMessages(arrayOf(message))?.firstOrNull()?.uid
        }

    // --- Helpers ---------------------------------------------------------------------------

    private suspend fun <T> withFolder(
        account: AccountConfig,
        path: String,
        mode: Int,
        block: (IMAPFolder) -> T,
    ): T = withStore(account) { store ->
        val folder = existingFolder(store, path)
        folder.open(mode)
        try {
            block(folder)
        } finally {
            if (folder.isOpen) folder.close(false)
        }
    }

    private fun existingFolder(store: IMAPStore, path: String): IMAPFolder {
        val folder = store.getFolder(path) as IMAPFolder
        if (!folder.exists()) throw MailException(MailErrorCode.FOLDER_NOT_FOUND, "Folder not found: $path")
        return folder
    }

    private fun select(folder: IMAPFolder, query: MessageQuery): Array<Message> = when (query) {
        is MessageQuery.ByUids -> folder.getMessagesByUID(query.uids.toLongArray()).filterNotNull().toTypedArray()
        is MessageQuery.UidRange -> folder.getMessagesByUID(query.fromUid, query.toUid ?: UIDFolder.MAXUID)
        is MessageQuery.Latest -> {
            val total = folder.messageCount
            if (total == 0 || query.count <= 0) emptyArray() else folder.getMessages(maxOf(1, total - query.count + 1), total)
        }
    }

    private fun messageByUid(folder: IMAPFolder, uid: Long): Message =
        folder.getMessageByUID(uid) ?: throw MailException(MailErrorCode.MESSAGE_NOT_FOUND, "Message $uid not found.")

    private fun envelopeOf(folder: IMAPFolder, message: IMAPMessage): Envelope {
        val references = message.getHeader("References")?.joinToString(" ").orEmpty()
        return Envelope(
            uid = folder.getUID(message),
            messageId = message.messageID,
            inReplyTo = message.inReplyTo?.let(::firstMessageId),
            references = messageIds(references),
            subject = message.subject,
            from = addresses(message.from),
            to = addresses(message.getRecipients(Message.RecipientType.TO)),
            cc = addresses(message.getRecipients(Message.RecipientType.CC)),
            replyTo = addresses(message.replyTo).takeUnless { it == addresses(message.from) }.orEmpty(),
            dateSent = message.sentDate?.time,
            dateReceived = message.receivedDate?.time,
            size = message.size,
            flags = flagNames(message.flags),
            hasAttachments = try {
                MimeParts.hasAttachments(message)
            } catch (_: Exception) {
                false
            },
        )
    }

    private fun addresses(list: Array<jakarta.mail.Address>?): List<MailAddress> =
        list.orEmpty().filterIsInstance<InternetAddress>().map { MailAddress(it.personal, it.address) }

    companion object {
        private val messageIdPattern = Regex("<[^<>\\s]+>")

        fun messageIds(header: String): List<String> = messageIdPattern.findAll(header).map { it.value }.toList()

        private fun firstMessageId(header: String) = messageIds(header).firstOrNull() ?: header.trim()

        private val SYSTEM_FLAGS = listOf(
            Flags.Flag.SEEN to "\\Seen",
            Flags.Flag.FLAGGED to "\\Flagged",
            Flags.Flag.ANSWERED to "\\Answered",
            Flags.Flag.DRAFT to "\\Draft",
            Flags.Flag.DELETED to "\\Deleted",
        )

        fun flagNames(flags: Flags): List<String> =
            SYSTEM_FLAGS.filter { flags.contains(it.first) }.map { it.second } + flags.userFlags

        fun flagsOf(names: List<String>): Flags = Flags().apply {
            for (name in names) {
                val system = SYSTEM_FLAGS.firstOrNull { it.second.equals(name, ignoreCase = true) }
                if (system != null) add(system.first) else add(name)
            }
        }
    }
}
