package com.despatch.mobile.mail

import jakarta.mail.AuthenticationFailedException
import jakarta.mail.MessagingException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.crypto.KeyGenerator
import javax.net.ssl.SSLHandshakeException

class MailErrorsTest {
    private fun code(error: Throwable) = MailErrors.classify(error).code

    @Test
    fun recognisesAuthenticationProblems() {
        assertEquals(MailErrorCode.AUTH_FAILED, code(AuthenticationFailedException("[AUTHENTICATIONFAILED] Invalid credentials")))
        assertEquals(
            MailErrorCode.APP_PASSWORD_REQUIRED,
            code(AuthenticationFailedException("534-5.7.9 Application-specific password required.")),
        )
        assertEquals(
            MailErrorCode.APP_PASSWORD_REQUIRED,
            code(AuthenticationFailedException("[ALERT] Please log in via your web browser")),
        )
        assertEquals(
            MailErrorCode.BASIC_AUTH_DISABLED,
            code(AuthenticationFailedException("535 5.7.139 Authentication unsuccessful, basic authentication is disabled.")),
        )
    }

    @Test
    fun recognisesNetworkProblemsInNestedExceptions() {
        assertEquals(MailErrorCode.TLS_FAILED, code(MessagingException("connect", SSLHandshakeException("bad cert"))))
        assertEquals(MailErrorCode.TIMEOUT, code(MessagingException("read", SocketTimeoutException())))
        assertEquals(MailErrorCode.CONNECTION_FAILED, code(MessagingException("connect", UnknownHostException("imap.nope"))))
        assertEquals(MailErrorCode.SERVER_ERROR, code(MessagingException("NO something else")))
    }

    @Test
    fun keepsExistingMailExceptions() {
        val original = MailException(MailErrorCode.FOLDER_NOT_FOUND, "x")
        assertTrue(MailErrors.classify(original) === original)
    }

    @Test
    fun retriesOnlyStaleConnections() {
        assertTrue(MailErrors.isStaleConnection(MessagingException("x", java.io.IOException("reset"))))
        assertFalse(MailErrors.isStaleConnection(AuthenticationFailedException("no")))
        assertFalse(MailErrors.isStaleConnection(MessagingException("NO")))
    }
}

class FolderRolesTest {
    private fun candidate(path: String, vararg attributes: String) =
        FolderRoles.Candidate(path, path.substringAfterLast('/').substringAfterLast('.'), attributes.toList())

    @Test
    fun specialUseAttributesWinOverNames() {
        val roles = FolderRoles.assign(
            listOf(
                candidate("INBOX"),
                candidate("Sent"),
                candidate("[Gmail]/Sent Mail", "\\HasNoChildren", "\\Sent"),
                candidate("[Gmail]/Bin", "\\Trash"),
                candidate("INBOX.Drafts"),
                candidate("Spam"),
                candidate("Projects"),
            ),
        )
        assertEquals("inbox", roles["INBOX"])
        assertEquals("sent", roles["[Gmail]/Sent Mail"])
        assertNull("name fallback must not duplicate a role", roles["Sent"])
        assertEquals("trash", roles["[Gmail]/Bin"])
        assertEquals("drafts", roles["INBOX.Drafts"])
        assertEquals("junk", roles["Spam"])
        assertNull(roles["Projects"])
    }
}

class CredentialStoreTest {
    private val values = mutableMapOf<String, String>()
    private val storage = object : CredentialStore.KeyValueStorage {
        override fun get(key: String) = values[key]
        override fun put(key: String, value: String) {
            values[key] = value
        }
        override fun remove(key: String) {
            values.remove(key)
        }
    }
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @Test
    fun encryptsAndDecryptsPasswords() {
        val store = CredentialStore(storage) { key }
        store.save("acc", "pässwörd 🔑")

        assertTrue(store.has("acc"))
        assertFalse("stored value must not contain the password", values.values.single().contains("pässwörd"))
        assertEquals("pässwörd 🔑", store.passwordFor("acc"))

        store.delete("acc")
        assertNull(store.passwordFor("acc"))
    }

    @Test
    fun returnsNullWhenTheKeyChanged() {
        CredentialStore(storage) { key }.save("acc", "secret")
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertNull(CredentialStore(storage) { otherKey }.passwordFor("acc"))
    }
}

class MessageIdTest {
    @Test
    fun parsesReferencesHeaders() {
        assertEquals(
            listOf("<a@x>", "<b@y>", "<c@z>"),
            ImapService.messageIds("<a@x>\r\n <b@y>  junk <c@z>"),
        )
    }
}
