package com.despatch.mobile.mail

import jakarta.mail.Folder
import jakarta.mail.Session
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Properties

class ImapServiceTest {
    private lateinit var server: TestMailServer
    private lateinit var imap: ImapService
    private val pdf = ByteArray(4096) { (it % 251).toByte() }

    @Before
    fun setUp() {
        server = TestMailServer()
        imap = ImapService(server.passwords)
    }

    @After
    fun tearDown() {
        imap.disconnectAll()
        server.close()
    }

    private fun createFolders(vararg names: String) {
        val store = Session.getInstance(Properties()).getStore("imap")
        store.connect("127.0.0.1", server.greenMail.imap.port, server.login, server.password)
        names.forEach { store.getFolder(it).create(Folder.HOLDS_MESSAGES) }
        store.close()
    }

    private fun deliverSample() {
        server.deliver(TestMailServer.message("First", messageId = "<m1@example.org>"))
        server.deliver(
            TestMailServer.message(
                "Re: First – ünïcödé",
                from = "=?UTF-8?Q?Zo=C3=AB?= <zoe@example.net>",
                messageId = "<m2@example.net>",
                inReplyTo = "<m1@example.org>",
                references = "<m0@example.org>\r\n <m1@example.org>",
            ),
        )
        server.deliver(TestMailServer.withAttachment("Invoice", pdf))
        server.deliver(TestMailServer.withInlineImage("Newsletter"))
    }

    @Test
    fun listsFoldersWithRoles() = runBlocking<Unit> {
        createFolders("Sent", "Trash", "Projects")
        val folders = imap.listFolders(server.account).associateBy { it.path }

        assertEquals("inbox", folders.getValue("INBOX").role)
        assertEquals("sent", folders.getValue("Sent").role)
        assertEquals("trash", folders.getValue("Trash").role)
        assertNull(folders.getValue("Projects").role)
        assertTrue(folders.getValue("INBOX").selectable)
    }

    @Test
    fun reportsFolderStatusInOneCommand() = runBlocking<Unit> {
        deliverSample()
        val status = imap.folderStatus(server.account, "INBOX")

        assertEquals(4, status.messages)
        assertEquals(4, status.unseen)
        assertTrue(status.uidValidity > 0)
        assertTrue(status.uidNext > 4)
    }

    @Test
    fun fetchesEnvelopesWithThreadingHeadersAndAttachmentFlag() = runBlocking<Unit> {
        deliverSample()
        val envelopes = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10))

        assertEquals(listOf("First", "Re: First – ünïcödé", "Invoice", "Newsletter"), envelopes.map { it.subject })
        assertEquals(envelopes.map { it.uid }.sorted(), envelopes.map { it.uid })

        val reply = envelopes[1]
        assertEquals("<m2@example.net>", reply.messageId)
        assertEquals("<m1@example.org>", reply.inReplyTo)
        assertEquals(listOf("<m0@example.org>", "<m1@example.org>"), reply.references)
        assertEquals(MailAddress("Zoë", "zoe@example.net"), reply.from.single())
        assertEquals(1_700_000_000_000, reply.dateSent)
        assertNotNull(reply.dateReceived)
        assertTrue(reply.size > 0)
        assertTrue(reply.flags.isEmpty())

        assertFalse(envelopes[0].hasAttachments)
        assertTrue(envelopes[2].hasAttachments)
        assertFalse("inline images are not attachments", envelopes[3].hasAttachments)
    }

    @Test
    fun selectsByLatestAndUidRange() = runBlocking<Unit> {
        deliverSample()
        val all = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10))

        val latest = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(2))
        assertEquals(all.takeLast(2).map { it.uid }, latest.map { it.uid })

        val fromSecond = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.UidRange(all[1].uid, null))
        assertEquals(all.drop(1).map { it.uid }, fromSecond.map { it.uid })

        val byUids = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.ByUids(listOf(all[3].uid, 99_999)))
        assertEquals(listOf(all[3].uid), byUids.map { it.uid })
    }

    @Test
    fun fetchesBodyWithoutMarkingSeen() = runBlocking<Unit> {
        deliverSample()
        val invoice = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10))[2]
        val body = imap.fetchBody(server.account, "INBOX", invoice.uid)

        assertEquals("Hello text", body.text?.trim())
        assertEquals("<p>Hello <b>html</b></p>", body.html?.trim())
        val attachment = body.attachments.single()
        assertEquals("2", attachment.partId)
        assertEquals("Invoice März.pdf", attachment.filename)
        assertEquals("application/pdf", attachment.mimeType)
        assertFalse(attachment.inline)

        val flags = imap.fetchFlags(server.account, "INBOX", MessageQuery.ByUids(listOf(invoice.uid))).single()
        assertFalse("\\Seen" in flags.flags)
    }

    @Test
    fun listsInlineImagesSeparately() = runBlocking<Unit> {
        deliverSample()
        val newsletter = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(1)).single()
        val body = imap.fetchBody(server.account, "INBOX", newsletter.uid)

        val image = body.attachments.single()
        assertTrue(image.inline)
        assertEquals("logo", image.contentId)
        assertEquals("<img src=\"cid:logo\">", body.html?.trim())
    }

    @Test
    fun downloadsAttachmentBytes() = runBlocking<Unit> {
        deliverSample()
        val invoice = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10))[2]
        val target = File(Files.createTempDirectory("despatch").toFile(), "invoice.pdf")

        val written = imap.downloadPart(server.account, "INBOX", invoice.uid, "2", target)

        assertEquals(pdf.size.toLong(), written)
        assertArrayEquals(pdf, target.readBytes())
    }

    @Test
    fun setsAndClearsFlags() = runBlocking<Unit> {
        deliverSample()
        val uids = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(2)).map { it.uid }

        imap.setFlags(server.account, "INBOX", uids, add = listOf("\\Seen", "\\Flagged", "\$Forwarded"), remove = emptyList())
        imap.setFlags(server.account, "INBOX", uids.take(1), add = emptyList(), remove = listOf("\\Flagged"))

        val flags = imap.fetchFlags(server.account, "INBOX", MessageQuery.ByUids(uids)).associate { it.uid to it.flags }
        assertEquals(listOf("\\Seen", "\$Forwarded"), flags.getValue(uids[0]))
        assertEquals(listOf("\\Seen", "\\Flagged", "\$Forwarded"), flags.getValue(uids[1]))
        assertEquals(2, imap.folderStatus(server.account, "INBOX").unseen)
    }

    @Test
    fun movesMessages() = runBlocking<Unit> {
        deliverSample()
        createFolders("Archive")
        val first = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10)).first()

        val newUids = imap.moveMessages(server.account, "INBOX", listOf(first.uid), "Archive")

        assertEquals(1, newUids.size)
        assertEquals(3, imap.folderStatus(server.account, "INBOX").messages)
        val archived = imap.fetchEnvelopes(server.account, "Archive", MessageQuery.Latest(10)).single()
        assertEquals("First", archived.subject)
        newUids.single()?.let { assertEquals(it, archived.uid) }
    }

    @Test
    fun deletesMessagesPermanently() = runBlocking<Unit> {
        deliverSample()
        val uids = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10)).map { it.uid }

        imap.deleteMessages(server.account, "INBOX", uids.take(2))

        val remaining = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(10)).map { it.uid }
        assertEquals(uids.drop(2), remaining)
    }

    @Test
    fun reconnectsWhenTheCachedConnectionDies() = runBlocking<Unit> {
        deliverSample()
        imap.folderStatus(server.account, "INBOX")

        server.restart()

        // The data is gone after the restart, but the call must succeed on a fresh connection.
        assertEquals(0, imap.folderStatus(server.account, "INBOX").messages)
    }

    @Test
    fun testsConnectionWithAnUnsavedPassword() = runBlocking<Unit> {
        val noStoredPassword = ImapService { null }
        val capabilities = noStoredPassword.test(server.account, server.password)
        assertTrue(capabilities.isNotEmpty())
    }

    @Test
    fun classifiesErrors() = runBlocking<Unit> {
        expectError(MailErrorCode.AUTH_FAILED) { ImapService { "wrong" }.listFolders(server.account) }
        expectError(MailErrorCode.NO_CREDENTIALS) { ImapService { null }.listFolders(server.account) }
        expectError(MailErrorCode.FOLDER_NOT_FOUND) { imap.folderStatus(server.account, "Nope") }
        expectError(MailErrorCode.MESSAGE_NOT_FOUND) { imap.fetchBody(server.account, "INBOX", 12345) }
        expectError(MailErrorCode.CONNECTION_FAILED) {
            val closedPort = server.account.copy(imap = server.account.imap.copy(port = 1))
            ImapService { server.password }.listFolders(closedPort)
        }
    }

    private suspend fun expectError(code: MailErrorCode, block: suspend () -> Unit) {
        try {
            block()
            fail("Expected $code")
        } catch (error: MailException) {
            assertEquals(error.message, code, error.code)
        }
    }
}
