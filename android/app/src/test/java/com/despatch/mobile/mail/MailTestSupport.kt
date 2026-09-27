package com.despatch.mobile.mail

import com.icegreen.greenmail.util.GreenMail
import com.icegreen.greenmail.util.ServerSetup
import com.icegreen.greenmail.util.ServerSetupTest
import jakarta.activation.DataHandler
import jakarta.mail.Message
import jakarta.mail.Session
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeBodyPart
import jakarta.mail.internet.MimeMessage
import jakarta.mail.internet.MimeMultipart
import jakarta.mail.util.ByteArrayDataSource
import java.util.Date
import java.util.Properties

/** A GreenMail server with one mailbox, plus builders for realistic test messages. */
class TestMailServer : AutoCloseable {
    val email = "alice@example.com"
    val login = "alice"
    val password = "correct horse"

    private var setups: Array<ServerSetup> =
        arrayOf(ServerSetupTest.SMTP.dynamicPort(), ServerSetupTest.IMAP.dynamicPort())
    var greenMail = start()
        private set

    private fun start() = GreenMail(setups).also {
        it.start()
        it.setUser(email, login, password)
        // Keep the ports so a restart comes back on the same address.
        setups = arrayOf(
            ServerSetup(it.smtp.port, null, ServerSetup.PROTOCOL_SMTP),
            ServerSetup(it.imap.port, null, ServerSetup.PROTOCOL_IMAP),
        )
    }

    /** Simulates the server dropping every connection (and losing its data). */
    fun restart() {
        greenMail.stop()
        greenMail = start()
    }

    val account
        get() = AccountConfig(
            id = "acc-1",
            email = email,
            displayName = "Alice",
            imap = ServerConfig("127.0.0.1", greenMail.imap.port, Security.NONE, login),
            smtp = ServerConfig("127.0.0.1", greenMail.smtp.port, Security.NONE, login),
        )

    val passwords = PasswordSource { if (it == "acc-1") password else null }

    fun deliver(message: MimeMessage) {
        greenMail.userManager.getUser(login).deliver(message)
    }

    override fun close() = greenMail.stop()

    companion object {
        private val session: Session = Session.getInstance(Properties())

        fun message(
            subject: String,
            from: String = "Bob Smith <bob@example.org>",
            to: String = "alice@example.com",
            messageId: String? = null,
            inReplyTo: String? = null,
            references: String? = null,
            sent: Date = Date(1_700_000_000_000),
            build: MimeMessage.() -> Unit = { setText("Plain body", "UTF-8") },
        ): MimeMessage = object : MimeMessage(session) {
            override fun updateMessageID() {
                if (messageId != null) setHeader("Message-ID", messageId) else super.updateMessageID()
            }
        }.apply {
            setFrom(InternetAddress(from))
            setRecipients(Message.RecipientType.TO, to)
            setSubject(subject, "UTF-8")
            sentDate = sent
            inReplyTo?.let { setHeader("In-Reply-To", it) }
            references?.let { setHeader("References", it) }
            build()
            saveChanges()
        }

        /** multipart/mixed: (text + html alternative) + PDF attachment. */
        fun withAttachment(subject: String, pdfBytes: ByteArray) = message(subject) {
            val alternative = MimeMultipart("alternative").apply {
                addBodyPart(MimeBodyPart().apply { setText("Hello text", "UTF-8", "plain") })
                addBodyPart(MimeBodyPart().apply { setText("<p>Hello <b>html</b></p>", "UTF-8", "html") })
            }
            val mixed = MimeMultipart("mixed").apply {
                addBodyPart(MimeBodyPart().apply { setContent(alternative) })
                addBodyPart(MimeBodyPart().apply {
                    dataHandler = DataHandler(ByteArrayDataSource(pdfBytes, "application/pdf"))
                    fileName = "Invoice März.pdf"
                    disposition = jakarta.mail.Part.ATTACHMENT
                })
            }
            setContent(mixed)
        }

        /** multipart/related: html + inline image referenced by Content-ID. Not an attachment. */
        fun withInlineImage(subject: String) = message(subject) {
            val related = MimeMultipart("related").apply {
                addBodyPart(MimeBodyPart().apply { setText("<img src=\"cid:logo\">", "UTF-8", "html") })
                addBodyPart(MimeBodyPart().apply {
                    dataHandler = DataHandler(ByteArrayDataSource(byteArrayOf(1, 2, 3), "image/png"))
                    contentID = "<logo>"
                    disposition = jakarta.mail.Part.INLINE
                })
            }
            setContent(related)
        }
    }
}
