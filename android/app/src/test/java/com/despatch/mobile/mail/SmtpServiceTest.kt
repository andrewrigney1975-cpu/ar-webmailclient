package com.despatch.mobile.mail

import jakarta.mail.Folder
import jakarta.mail.Multipart
import jakarta.mail.Part
import jakarta.mail.Session
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.util.Properties

class SmtpServiceTest {
    private lateinit var server: TestMailServer
    private lateinit var smtp: SmtpService
    private lateinit var imap: ImapService

    @Before
    fun setUp() {
        server = TestMailServer()
        smtp = SmtpService(server.passwords)
        imap = ImapService(server.passwords)
    }

    @After
    fun tearDown() {
        imap.disconnectAll()
        server.close()
    }

    private fun reply(attachments: List<OutgoingAttachment> = emptyList()) = OutgoingMessage(
        from = MailAddress("Alice", server.email),
        to = listOf(MailAddress("Bob", "bob@example.org")),
        cc = emptyList(),
        bcc = listOf(MailAddress(null, "secret@example.org")),
        replyTo = emptyList(),
        subject = "Re: Plans – café",
        text = "See you there",
        html = "<p>See you <b>there</b></p>",
        inReplyTo = "<m1@example.org>",
        references = listOf("<m0@example.org>", "<m1@example.org>"),
        attachments = attachments,
    )

    @Test
    fun sendsWithThreadingHeadersAndSenderDomainMessageId() = runBlocking<Unit> {
        val sent = smtp.send(server.account, reply())

        assertTrue(server.greenMail.waitForIncomingEmail(5_000, 2))
        val received = server.greenMail.receivedMessages.first()
        assertEquals("Re: Plans – café", received.subject)
        assertEquals("<m1@example.org>", received.getHeader("In-Reply-To").single())
        assertEquals("<m0@example.org> <m1@example.org>", received.getHeader("References").single())
        assertTrue(received.messageID.endsWith("@example.com>"))
        assertEquals(sent.messageID, received.messageID)
        assertTrue("Bcc must not be sent in headers", received.getHeader("Bcc") == null)
        assertTrue(received.isMimeType("multipart/alternative"))
    }

    @Test
    fun attachesFiles() = runBlocking<Unit> {
        val file = Files.createTempFile("despatch", ".txt").toFile().apply { writeText("attached") }
        smtp.send(server.account, reply(listOf(OutgoingAttachment("notes.txt", "text/plain", file.path))))

        assertTrue(server.greenMail.waitForIncomingEmail(5_000, 1))
        val received = server.greenMail.receivedMessages.first()
        val mixed = received.content as Multipart
        assertTrue(received.isMimeType("multipart/mixed"))
        val attachment = mixed.getBodyPart(1)
        assertEquals(Part.ATTACHMENT, attachment.disposition)
        assertEquals("notes.txt", attachment.fileName)
    }

    @Test
    fun savesTheSentMessageToTheSentFolder() = runBlocking<Unit> {
        val store = Session.getInstance(Properties()).getStore("imap")
        store.connect("127.0.0.1", server.greenMail.imap.port, server.login, server.password)
        store.getFolder("Sent").create(Folder.HOLDS_MESSAGES)
        store.close()

        val message = smtp.send(server.account, reply())
        val uid = imap.append(server.account, "Sent", message, listOf("\\Seen"))

        assertNotNull(uid)
        val saved = imap.fetchEnvelopes(server.account, "Sent", MessageQuery.Latest(1)).single()
        assertEquals(message.messageID, saved.messageId)
        assertEquals(listOf("\\Seen"), saved.flags)
        assertEquals("<m1@example.org>", saved.inReplyTo)
    }

    @Test
    fun buildsAndStoresDraftsWithoutRecipients() = runBlocking<Unit> {
        val store = Session.getInstance(Properties()).getStore("imap")
        store.connect("127.0.0.1", server.greenMail.imap.port, server.login, server.password)
        store.getFolder("Drafts").create(Folder.HOLDS_MESSAGES)
        store.close()

        val draft = SmtpService.build(
            MailSessions.imap(server.account.imap),
            reply().copy(to = emptyList(), bcc = emptyList(), subject = "Half written"),
            requireRecipients = false,
        )
        val first = imap.append(server.account, "Drafts", draft, listOf("\\Draft", "\\Seen"))
        assertNotNull(first)
        imap.deleteMessages(server.account, "Drafts", listOf(first!!))
        val second = imap.append(server.account, "Drafts", draft, listOf("\\Draft", "\\Seen"))

        val saved = imap.fetchEnvelopes(server.account, "Drafts", MessageQuery.Latest(10)).single()
        assertEquals(second, saved.uid)
        assertEquals("Half written", saved.subject)
        assertTrue("\\Draft" in saved.flags)
    }

    @Test
    fun rejectsMessagesWithoutRecipients() = runBlocking<Unit> {
        try {
            smtp.send(server.account, reply().copy(to = emptyList(), bcc = emptyList()))
            fail("Expected INVALID_ARGUMENT")
        } catch (error: MailException) {
            assertEquals(MailErrorCode.INVALID_ARGUMENT, error.code)
        }
    }

    @Test
    fun testsSmtpLogin() = runBlocking<Unit> {
        smtp.test(server.account, server.password)
        try {
            smtp.test(server.account, "wrong")
            fail("Expected AUTH_FAILED")
        } catch (error: MailException) {
            assertEquals(MailErrorCode.AUTH_FAILED, error.code)
        }
    }
}
