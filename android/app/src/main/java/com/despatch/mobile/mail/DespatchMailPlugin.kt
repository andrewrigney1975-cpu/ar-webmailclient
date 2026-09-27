package com.despatch.mobile.mail

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File

/**
 * IMAP/SMTP bridge for the web app (PLAN.md §1). Kept thin: it moves data
 * between JS and the mail services; threading, sorting and rendering happen
 * in JS. The JS wrapper is src/js/mail/bridge.js.
 */
@CapacitorPlugin(name = "DespatchMail")
class DespatchMailPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var credentials: CredentialStore
    private lateinit var imap: ImapService
    private lateinit var smtp: SmtpService

    override fun load() {
        credentials = CredentialStore.forAndroid(context)
        imap = ImapService(credentials)
        smtp = SmtpService(credentials)
    }

    override fun handleOnDestroy() {
        scope.cancel()
        Thread { imap.disconnectAll() }.start()
    }

    private fun run(call: PluginCall, block: suspend () -> JSObject?) {
        scope.launch {
            try {
                val result = block()
                if (result == null) call.resolve() else call.resolve(result)
            } catch (error: Throwable) {
                val mailError = MailErrors.classify(error)
                call.reject(mailError.message, mailError.code.name, mailError)
            }
        }
    }

    // --- Credentials -----------------------------------------------------------------------

    @PluginMethod
    fun setCredentials(call: PluginCall) = run(call) {
        val accountId = call.requireString("accountId")
        credentials.save(accountId, call.requireString("password"))
        imap.disconnect(accountId)
        null
    }

    @PluginMethod
    fun deleteCredentials(call: PluginCall) = run(call) {
        val accountId = call.requireString("accountId")
        credentials.delete(accountId)
        imap.disconnect(accountId)
        null
    }

    @PluginMethod
    fun hasCredentials(call: PluginCall) = run(call) {
        JSObject().put("value", credentials.has(call.requireString("accountId")))
    }

    // --- Connection ------------------------------------------------------------------------

    /** Checks IMAP (and SMTP when configured) with an optional not-yet-saved password. */
    @PluginMethod
    fun testConnection(call: PluginCall) = run(call) {
        val account = call.requireAccount()
        val password = call.getString("password")
        val capabilities = imap.test(account, password)
        if (account.smtp != null) smtp.test(account, password)
        JSObject()
            .put("capabilities", JSArray().also { array -> capabilities.forEach { array.put(it) } })
            .put("smtpChecked", account.smtp != null)
    }

    @PluginMethod
    fun disconnect(call: PluginCall) = run(call) {
        imap.disconnect(call.requireString("accountId"))
        null
    }

    // --- Folders and messages --------------------------------------------------------------

    @PluginMethod
    fun listFolders(call: PluginCall) = run(call) {
        JSObject().put("folders", imap.listFolders(call.requireAccount()).toJsArray { it.toJs() })
    }

    @PluginMethod
    fun folderStatus(call: PluginCall) = run(call) {
        imap.folderStatus(call.requireAccount(), call.requireString("path")).toJs()
    }

    @PluginMethod
    fun fetchEnvelopes(call: PluginCall) = run(call) {
        val envelopes = imap.fetchEnvelopes(call.requireAccount(), call.requireString("path"), call.messageQuery())
        JSObject().put("messages", envelopes.toJsArray { it.toJs() })
    }

    @PluginMethod
    fun fetchFlags(call: PluginCall) = run(call) {
        val flags = imap.fetchFlags(call.requireAccount(), call.requireString("path"), call.messageQuery())
        JSObject().put("messages", flags.toJsArray { it.toJs() })
    }

    @PluginMethod
    fun fetchBody(call: PluginCall) = run(call) {
        imap.fetchBody(call.requireAccount(), call.requireString("path"), call.requireLong("uid")).toJs()
    }

    /** Saves an attachment to the app cache and returns its file path. */
    @PluginMethod
    fun downloadAttachment(call: PluginCall) = run(call) {
        val account = call.requireAccount()
        val uid = call.requireLong("uid")
        val partId = call.requireString("partId")
        val filename = safeFilename(call.getString("filename") ?: "attachment")
        val folderKey = safeFilename(call.requireString("path"))
        val destination = File(
            context.cacheDir,
            "attachments/${safeFilename(account.id)}/$folderKey/$uid/${safeFilename(partId)}/$filename",
        )
        val size = imap.downloadPart(account, call.requireString("path"), uid, partId, destination)
        JSObject().put("path", destination.absolutePath).put("size", size)
    }

    @PluginMethod
    fun setFlags(call: PluginCall) = run(call) {
        imap.setFlags(
            call.requireAccount(),
            call.requireString("path"),
            call.longList("uids"),
            add = call.stringList("add"),
            remove = call.stringList("remove"),
        )
        null
    }

    @PluginMethod
    fun moveMessages(call: PluginCall) = run(call) {
        val newUids = imap.moveMessages(
            call.requireAccount(),
            call.requireString("path"),
            call.longList("uids"),
            call.requireString("destination"),
        )
        JSObject().put("newUids", JSArray().also { array -> newUids.forEach { array.put(it) } })
    }

    // --- Sending ---------------------------------------------------------------------------

    /**
     * Sends via SMTP, then optionally saves a copy to `sentFolder`. A failure to
     * save the copy doesn't fail the send; it is reported in `sentFolderError`.
     */
    @PluginMethod
    fun send(call: PluginCall) = run(call) {
        val account = call.requireAccount()
        val message = smtp.send(account, call.outgoingMessage())
        val result = JSObject().put("messageId", message.messageID)

        call.getString("sentFolder")?.takeIf { it.isNotBlank() }?.let { sentFolder ->
            try {
                result.put("sentFolderUid", imap.append(account, sentFolder, message, listOf("\\Seen")))
            } catch (error: Throwable) {
                result.put("sentFolderError", MailErrors.classify(error).code.name)
            }
        }
        result
    }

    private fun safeFilename(name: String) =
        name.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().trimStart('.').ifEmpty { "file" }.take(120)
}
