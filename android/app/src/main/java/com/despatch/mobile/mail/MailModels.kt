package com.despatch.mobile.mail

/*
 * Plain data passed between the plugin and the mail services. Nothing here
 * depends on Android or Jakarta Mail, so it can be used from JVM unit tests.
 */

enum class Security {
    TLS,
    STARTTLS,
    NONE;

    companion object {
        fun parse(value: String?): Security = when (value?.lowercase()) {
            "tls", "ssl" -> TLS
            "starttls" -> STARTTLS
            "none" -> NONE
            else -> throw MailException(MailErrorCode.INVALID_ARGUMENT, "Unknown security mode: $value")
        }
    }
}

data class ServerConfig(
    val host: String,
    val port: Int,
    val security: Security,
    val username: String,
)

data class AccountConfig(
    val id: String,
    val email: String,
    val displayName: String?,
    val imap: ServerConfig,
    val smtp: ServerConfig?,
)

data class MailAddress(val name: String?, val address: String)

data class FolderInfo(
    val path: String,
    val name: String,
    val delimiter: String?,
    val role: String?,
    val attributes: List<String>,
    val subscribed: Boolean,
    val selectable: Boolean,
)

data class FolderStatus(
    val path: String,
    val uidValidity: Long,
    val uidNext: Long,
    val highestModSeq: Long?,
    val messages: Int,
    val unseen: Int,
)

/** Which messages to fetch from a folder. */
sealed interface MessageQuery {
    data class ByUids(val uids: List<Long>) : MessageQuery

    /** Inclusive UID range; a null [toUid] means "up to the newest message". */
    data class UidRange(val fromUid: Long, val toUid: Long?) : MessageQuery

    /** The newest [count] messages by sequence number. */
    data class Latest(val count: Int) : MessageQuery
}

data class Envelope(
    val uid: Long,
    val messageId: String?,
    val inReplyTo: String?,
    val references: List<String>,
    val subject: String?,
    val from: List<MailAddress>,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val replyTo: List<MailAddress>,
    /** Date header, epoch millis. */
    val dateSent: Long?,
    /** IMAP INTERNALDATE, epoch millis. */
    val dateReceived: Long?,
    /** RFC822.SIZE in bytes. */
    val size: Int,
    val flags: List<String>,
    val hasAttachments: Boolean,
)

data class MessageFlags(val uid: Long, val flags: List<String>)

data class AttachmentInfo(
    /** IMAP section number, e.g. "2" or "1.2". */
    val partId: String,
    val filename: String?,
    val mimeType: String,
    val size: Int,
    val contentId: String?,
    val inline: Boolean,
)

data class MessageBody(
    val uid: Long,
    val text: String?,
    val html: String?,
    val attachments: List<AttachmentInfo>,
)

data class OutgoingAttachment(val filename: String, val mimeType: String, val path: String)

data class OutgoingMessage(
    val from: MailAddress,
    val to: List<MailAddress>,
    val cc: List<MailAddress>,
    val bcc: List<MailAddress>,
    val replyTo: List<MailAddress>,
    val subject: String,
    val text: String?,
    val html: String?,
    val inReplyTo: String?,
    val references: List<String>,
    val attachments: List<OutgoingAttachment>,
)

data class ConnectionTest(val imapCapabilities: List<String>, val smtpChecked: Boolean)

data class SendResult(val messageId: String, val sentFolderUid: Long?)
