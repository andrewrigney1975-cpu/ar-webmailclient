package com.despatch.mobile.mail

import jakarta.mail.Message
import jakarta.mail.Session
import jakarta.mail.internet.InternetAddress
import jakarta.mail.internet.MimeBodyPart
import jakarta.mail.internet.MimeMessage
import jakarta.mail.internet.MimeMultipart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Date
import java.util.UUID

class SmtpService(private val passwords: PasswordSource) {

    /** Connects and authenticates without sending anything. */
    suspend fun test(account: AccountConfig, password: String?) = withContext(Dispatchers.IO) {
        val config = smtpConfig(account)
        val session = MailSessions.smtp(config)
        try {
            session.getTransport(MailSessions.smtpProtocol(config)).use { transport ->
                transport.connect(config.host, config.port, config.username, passwordFor(account, password))
            }
        } catch (error: Throwable) {
            throw MailErrors.classify(error)
        }
    }

    /** Sends the message and returns it (with its final headers) so it can be saved to Sent. */
    suspend fun send(account: AccountConfig, outgoing: OutgoingMessage): MimeMessage = withContext(Dispatchers.IO) {
        val config = smtpConfig(account)
        val session = MailSessions.smtp(config)
        val message = build(session, outgoing)
        try {
            session.getTransport(MailSessions.smtpProtocol(config)).use { transport ->
                transport.connect(config.host, config.port, config.username, passwordFor(account, null))
                transport.sendMessage(message, message.allRecipients)
            }
        } catch (error: Throwable) {
            throw MailErrors.classify(error)
        }
        message
    }

    private fun smtpConfig(account: AccountConfig) = account.smtp
        ?: throw MailException(MailErrorCode.INVALID_ARGUMENT, "This account has no outgoing (SMTP) server.")

    private fun passwordFor(account: AccountConfig, password: String?) =
        password ?: passwords.passwordFor(account.id)
            ?: throw MailException(MailErrorCode.NO_CREDENTIALS, "No password is stored for this account.")

    companion object {
        private const val CHARSET = "UTF-8"

        /** Builds the MIME message. Drafts may not have recipients yet ([requireRecipients] false). */
        fun build(session: Session, outgoing: OutgoingMessage, requireRecipients: Boolean = true): MimeMessage {
            if (requireRecipients && outgoing.to.isEmpty() && outgoing.cc.isEmpty() && outgoing.bcc.isEmpty()) {
                throw MailException(MailErrorCode.INVALID_ARGUMENT, "The message has no recipients.")
            }
            val domain = outgoing.from.address.substringAfter('@', "despatch.invalid")
            val message = DespatchMimeMessage(session, domain)

            message.setFrom(internet(outgoing.from))
            message.setRecipients(Message.RecipientType.TO, outgoing.to.map(::internet).toTypedArray())
            message.setRecipients(Message.RecipientType.CC, outgoing.cc.map(::internet).toTypedArray())
            message.setRecipients(Message.RecipientType.BCC, outgoing.bcc.map(::internet).toTypedArray())
            if (outgoing.replyTo.isNotEmpty()) message.replyTo = outgoing.replyTo.map(::internet).toTypedArray()
            message.setSubject(outgoing.subject, CHARSET)
            message.sentDate = Date()
            outgoing.inReplyTo?.let { message.setHeader("In-Reply-To", it) }
            if (outgoing.references.isNotEmpty()) message.setHeader("References", outgoing.references.joinToString(" "))
            message.setHeader("User-Agent", "Despatch Mobile")

            val alternative = alternativeOf(outgoing)
            if (outgoing.attachments.isEmpty()) {
                if (alternative != null) {
                    message.setContent(alternative)
                } else {
                    message.setText(outgoing.html ?: outgoing.text.orEmpty(), CHARSET, if (outgoing.html != null) "html" else "plain")
                }
            } else {
                val mixed = MimeMultipart("mixed")
                mixed.addBodyPart(MimeBodyPart().apply {
                    if (alternative != null) {
                        setContent(alternative)
                    } else {
                        setText(outgoing.html ?: outgoing.text.orEmpty(), CHARSET, if (outgoing.html != null) "html" else "plain")
                    }
                })
                for (attachment in outgoing.attachments) {
                    mixed.addBodyPart(MimeBodyPart().apply {
                        attachFile(File(attachment.path), attachment.mimeType, null)
                        fileName = attachment.filename
                    })
                }
                message.setContent(mixed)
            }
            message.saveChanges()
            return message
        }

        /** multipart/alternative when there is both a text and an HTML version, otherwise null. */
        private fun alternativeOf(outgoing: OutgoingMessage): MimeMultipart? {
            if (outgoing.text == null || outgoing.html == null) return null
            return MimeMultipart("alternative").apply {
                addBodyPart(MimeBodyPart().apply { setText(outgoing.text, CHARSET, "plain") })
                addBodyPart(MimeBodyPart().apply { setText(outgoing.html, CHARSET, "html") })
            }
        }

        private fun internet(address: MailAddress) = InternetAddress(address.address, address.name, CHARSET)
    }

    /** Uses the sender's domain in Message-ID instead of the device hostname. */
    private class DespatchMimeMessage(session: Session, private val domain: String) : MimeMessage(session) {
        override fun updateMessageID() {
            setHeader("Message-ID", "<${UUID.randomUUID()}@$domain>")
        }
    }
}
