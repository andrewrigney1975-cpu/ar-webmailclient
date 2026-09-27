package com.despatch.mobile.mail

import jakarta.mail.Session
import java.util.Properties

/** Jakarta Mail session settings for IMAP and SMTP. */
object MailSessions {
    const val CONNECT_TIMEOUT_MS = 15_000
    const val IO_TIMEOUT_MS = 30_000
    private const val FETCH_SIZE_BYTES = 1024 * 1024

    init {
        // Be lenient with the malformed headers and parameters common in real mail.
        System.setProperty("mail.mime.decodetext.strict", "false")
        System.setProperty("mail.mime.parameters.strict", "false")
        System.setProperty("mail.mime.decodefilename", "true")
        System.setProperty("mail.mime.encodefilename", "true")
    }

    fun imapProtocol(config: ServerConfig) = if (config.security == Security.TLS) "imaps" else "imap"

    fun smtpProtocol(config: ServerConfig) = if (config.security == Security.TLS) "smtps" else "smtp"

    fun imap(config: ServerConfig): Session {
        val protocol = imapProtocol(config)
        val props = common(protocol, config)
        // Reading a body must not mark the message \Seen; the app decides that.
        props["mail.$protocol.peek"] = "true"
        props["mail.$protocol.fetchsize"] = FETCH_SIZE_BYTES.toString()
        props["mail.$protocol.partialfetch"] = "true"
        return Session.getInstance(props)
    }

    fun smtp(config: ServerConfig): Session {
        val protocol = smtpProtocol(config)
        val props = common(protocol, config)
        props["mail.$protocol.auth"] = "true"
        // Android devices have no meaningful hostname to send in EHLO.
        props["mail.$protocol.localhost"] = "[127.0.0.1]"
        return Session.getInstance(props)
    }

    private fun common(protocol: String, config: ServerConfig) = Properties().apply {
        this["mail.$protocol.host"] = config.host
        this["mail.$protocol.port"] = config.port.toString()
        this["mail.$protocol.connectiontimeout"] = CONNECT_TIMEOUT_MS.toString()
        this["mail.$protocol.timeout"] = IO_TIMEOUT_MS.toString()
        this["mail.$protocol.writetimeout"] = IO_TIMEOUT_MS.toString()
        this["mail.mime.address.strict"] = "false"
        when (config.security) {
            Security.TLS -> {
                this["mail.$protocol.ssl.socketFactory"] = AiaTrustManager.socketFactory
                this["mail.$protocol.ssl.checkserveridentity"] = "true"
            }
            Security.STARTTLS -> {
                this["mail.$protocol.starttls.enable"] = "true"
                this["mail.$protocol.starttls.required"] = "true"
                this["mail.$protocol.ssl.socketFactory"] = AiaTrustManager.socketFactory
                this["mail.$protocol.ssl.checkserveridentity"] = "true"
            }
            Security.NONE -> Unit
        }
    }
}
