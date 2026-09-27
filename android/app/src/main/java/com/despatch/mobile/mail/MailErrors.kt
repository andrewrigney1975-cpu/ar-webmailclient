package com.despatch.mobile.mail

import jakarta.mail.AuthenticationFailedException
import jakarta.mail.FolderClosedException
import jakarta.mail.FolderNotFoundException
import jakarta.mail.MessagingException
import jakarta.mail.SendFailedException
import jakarta.mail.StoreClosedException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

/** Error codes shared with JS (src/js/mail/bridge.js). */
enum class MailErrorCode {
    AUTH_FAILED,
    APP_PASSWORD_REQUIRED,
    BASIC_AUTH_DISABLED,
    NO_CREDENTIALS,
    CONNECTION_FAILED,
    TLS_FAILED,
    TIMEOUT,
    FOLDER_NOT_FOUND,
    MESSAGE_NOT_FOUND,
    RECIPIENT_REJECTED,
    INVALID_ARGUMENT,
    SERVER_ERROR,
}

class MailException(
    val code: MailErrorCode,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

object MailErrors {
    // Server responses that mean "your normal password won't work here".
    private val appPasswordHints = listOf(
        "application-specific password",
        "app password",
        "application specific password",
        "webalert",
        "web login required",
        "log in via your web browser",
        "invalidsecondfactor",
    )

    private val basicAuthDisabledHints = listOf(
        "basic authentication is disabled",
        "basicauthblocked",
        "5.7.139",
    )

    fun classify(error: Throwable): MailException {
        if (error is MailException) return error

        val chain = causeChain(error)
        val text = chain.mapNotNull { it.message }.joinToString(" ").lowercase()

        chain.firstOrNull { it is MailException }?.let { return it as MailException }

        return when {
            chain.any { it is AuthenticationFailedException } || looksLikeAuthFailure(text) -> when {
                basicAuthDisabledHints.any(text::contains) -> MailException(
                    MailErrorCode.BASIC_AUTH_DISABLED,
                    "This provider has password sign-in turned off. Support for it is planned for Despatch Mobile 2.0.",
                    error,
                )
                appPasswordHints.any(text::contains) -> MailException(
                    MailErrorCode.APP_PASSWORD_REQUIRED,
                    "This provider needs an app password instead of your normal password.",
                    error,
                )
                else -> MailException(MailErrorCode.AUTH_FAILED, "The username or password was not accepted.", error)
            }
            chain.any { it is SSLException || it is CertificateException } -> MailException(
                MailErrorCode.TLS_FAILED,
                "A secure connection to the server could not be established.",
                error,
            )
            chain.any { it is SocketTimeoutException } -> MailException(
                MailErrorCode.TIMEOUT,
                "The server took too long to respond.",
                error,
            )
            chain.any {
                it is UnknownHostException || it is ConnectException || it is NoRouteToHostException ||
                    it is StoreClosedException || it is FolderClosedException
            } -> MailException(MailErrorCode.CONNECTION_FAILED, "Could not connect to the mail server.", error)
            chain.any { it is FolderNotFoundException } -> MailException(
                MailErrorCode.FOLDER_NOT_FOUND,
                "The folder does not exist on the server.",
                error,
            )
            chain.any { it is SendFailedException && hasInvalidAddresses(it) } -> MailException(
                MailErrorCode.RECIPIENT_REJECTED,
                "The server rejected one or more recipients.",
                error,
            )
            else -> MailException(MailErrorCode.SERVER_ERROR, error.message ?: error.javaClass.simpleName, error)
        }
    }

    /** True for errors worth one reconnect-and-retry (the cached connection went stale). */
    fun isStaleConnection(error: Throwable): Boolean = causeChain(error).any {
        it is StoreClosedException || it is FolderClosedException || it is java.io.IOException
    } && causeChain(error).none { it is AuthenticationFailedException }

    private fun looksLikeAuthFailure(text: String) =
        "authenticationfailed" in text || "535" in text && "auth" in text

    private fun hasInvalidAddresses(error: SendFailedException) =
        !error.invalidAddresses.isNullOrEmpty() || !error.validUnsentAddresses.isNullOrEmpty()

    private fun causeChain(error: Throwable): List<Throwable> {
        val seen = mutableListOf<Throwable>()
        var current: Throwable? = error
        while (current != null && current !in seen) {
            seen += current
            current = current.cause ?: (current as? MessagingException)?.nextException
        }
        return seen
    }
}
