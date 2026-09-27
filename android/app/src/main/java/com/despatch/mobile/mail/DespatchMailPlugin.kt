package com.despatch.mobile.mail

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import android.Manifest
import android.provider.Settings
import android.os.PowerManager
import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import androidx.core.app.NotificationManagerCompat
import com.despatch.mobile.MainActivity
import com.despatch.mobile.notify.BackgroundStore
import com.despatch.mobile.notify.MailNotifier
import com.despatch.mobile.notify.PushService
import com.despatch.mobile.notify.SyncWorker
import org.json.JSONArray
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
@CapacitorPlugin(
    name = "DespatchMail",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class DespatchMailPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var credentials: CredentialStore
    private lateinit var imap: ImapService
    private lateinit var smtp: SmtpService

    override fun load() {
        credentials = CredentialStore.forAndroid(context)
        imap = ImapService(credentials)
        smtp = SmtpService(credentials)
        // The app may have been opened from a notification.
        activity?.intent?.let(::forwardNotificationIntent)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        forwardNotificationIntent(intent)
    }

    /** Tells JS which message a notification was for; kept until a listener is attached. */
    private fun forwardNotificationIntent(intent: Intent) {
        val action = when (intent.action) {
            MainActivity.ACTION_OPEN_MESSAGE -> "open"
            MainActivity.ACTION_REPLY -> "reply"
            else -> return
        }
        val accountId = intent.getStringExtra(MailNotifier.EXTRA_ACCOUNT) ?: return
        val data = JSObject()
            .put("action", action)
            .put("accountId", accountId)
            .put("path", intent.getStringExtra(MailNotifier.EXTRA_PATH))
            .put("uid", intent.getLongExtra(MailNotifier.EXTRA_UID, -1))
        intent.action = null // handle once, not again on configuration changes
        notifyListeners("notificationTapped", data, true)
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

    @PluginMethod
    fun searchServer(call: PluginCall) = run(call) {
        val uids = imap.search(call.requireAccount(), call.requireString("path"), call.searchCriteria())
        JSObject().put("uids", JSArray().also { array -> uids.forEach { array.put(it) } })
    }

    @PluginMethod
    fun deleteMessages(call: PluginCall) = run(call) {
        imap.deleteMessages(call.requireAccount(), call.requireString("path"), call.longList("uids"))
        null
    }

    // --- Files -------------------------------------------------------------------------------

    /** Opens a downloaded attachment in another app. Only files in the app cache are allowed. */
    @PluginMethod
    fun openFile(call: PluginCall) = run(call) {
        val uri = cacheFileUri(call.requireString("path"))
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, call.getString("mimeType") ?: "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            throw MailException(MailErrorCode.NO_APP, "No app on this device can open this file.")
        }
        null
    }

    /** Shows the system share sheet for a downloaded attachment. */
    @PluginMethod
    fun shareFile(call: PluginCall) = run(call) {
        val uri = cacheFileUri(call.requireString("path"))
        val send = Intent(Intent.ACTION_SEND)
            .setType(call.getString("mimeType") ?: "application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(
            Intent.createChooser(send, call.getString("title")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        null
    }

    /**
     * Copies a file from the app cache into Downloads (PLAN.md §4.7). Uses
     * MediaStore, so no storage permission is needed.
     */
    @PluginMethod
    fun saveToDownloads(call: PluginCall) = run(call) {
        val source = cacheFile(call.requireString("path"))
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, call.getString("filename") ?: source.name)
            put(MediaStore.Downloads.MIME_TYPE, call.getString("mimeType") ?: "application/octet-stream")
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw MailException(MailErrorCode.SERVER_ERROR, "Couldn’t create the file in Downloads.")
        try {
            resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out) } }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
        JSObject().put("uri", uri.toString())
    }

    /** A file inside the app cache; anything else is refused. */
    private fun cacheFile(path: String): File {
        val file = File(path).canonicalFile
        if (!file.path.startsWith(context.cacheDir.canonicalPath + File.separator) || !file.isFile) {
            throw MailException(MailErrorCode.INVALID_ARGUMENT, "File not found.")
        }
        return file
    }

    private fun cacheFileUri(path: String): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", cacheFile(path))

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

    // --- Notifications -----------------------------------------------------------------------

    /**
     * Hands the background checker (PLAN.md §4.4) the accounts to watch and
     * schedules it; starts or stops instant (IDLE) mode.
     * accounts: [{ account, notify, inboxPath, archivePath, accentColor }]
     */
    @PluginMethod
    fun configureBackgroundSync(call: PluginCall) = run(call) {
        val store = BackgroundStore(context)
        store.accountsJson = (call.getArray("accounts") ?: JSONArray()).toString()
        store.intervalMinutes = call.getInt("intervalMinutes") ?: 15
        store.push = call.getBoolean("push") ?: false

        val accounts = store.accounts
        val notifier = MailNotifier(context)
        accounts.forEach { notifier.ensureChannel(it) }
        notifier.removeChannelsExcept(accounts.map { it.account.id }.toSet())

        val watching = accounts.any { it.notify }
        if (watching) SyncWorker.schedule(context, store.intervalMinutes) else SyncWorker.cancel(context)
        if (watching && store.push) PushService.start(context) else PushService.stop(context)
        null
    }

    /** The app has shown this account's inbox up to [uid]: don't notify those, and clear its notifications. */
    @PluginMethod
    fun markNotified(call: PluginCall) = run(call) {
        val accountId = call.requireString("accountId")
        val store = BackgroundStore(context)
        NewMailChecker(imap, store).markSeen(accountId, call.requireLong("uidValidity"), call.requireLong("uid"))
        MailNotifier(context).cancelAccount(accountId)
        null
    }

    /**
     * Notification permission, whether Android restricts background work for the
     * app (battery optimisation), and the last background check.
     */
    @PluginMethod
    fun notificationStatus(call: PluginCall) = run(call) {
        val store = BackgroundStore(context)
        val power = context.getSystemService(PowerManager::class.java)
        JSObject()
            .put("permission", getPermissionState("notifications")?.toString()?.lowercase() ?: "prompt")
            .put("enabled", NotificationManagerCompat.from(context).areNotificationsEnabled())
            .put("batteryOptimized", !power.isIgnoringBatteryOptimizations(context.packageName))
            .put("lastCheckAt", store.lastCheckAt.takeIf { it > 0 })
            .put("lastCheckTrigger", store.lastCheckTrigger)
            .put("lastCheckNew", store.lastCheckNew)
            .put("lastCheckError", store.lastCheckError)
    }

    /**
     * Opens the app's page in system settings, where "App battery usage" can be
     * set to Unrestricted so background checks aren't held back while idle.
     */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) = run(call) {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        null
    }

    /** Runs a background check now (Settings > "Check now"), recording it like a scheduled one. */
    @PluginMethod
    fun checkInBackgroundNow(call: PluginCall) = run(call) {
        SyncWorker.checkAll(context, trigger = "manual")
        null
    }

    @PluginMethod
    fun openNotificationSettings(call: PluginCall) = run(call) {
        context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        null
    }

    // --- Theme ------------------------------------------------------------------------------

    /** Material You colours from the wallpaper, used as default account accents (PLAN.md §4.5). */
    @PluginMethod
    fun getDynamicColors(call: PluginCall) = run(call) {
        val ids = listOf(
            android.R.color.system_accent1_600,
            android.R.color.system_accent3_600,
            android.R.color.system_accent2_600,
            android.R.color.system_accent1_400,
            android.R.color.system_accent3_400,
        )
        val colors = JSArray()
        ids.map { context.getColor(it) }.distinct().forEach { colors.put(String.format("#%06x", it and 0xFFFFFF)) }
        JSObject().put("colors", colors)
    }

    /**
     * Saves a draft to the account's Drafts folder (flagged \Draft and \Seen)
     * and removes the previous copy (`replaceUid`). Returns the new UID when
     * the server reports it.
     */
    @PluginMethod
    fun saveDraft(call: PluginCall) = run(call) {
        val account = call.requireAccount()
        val folder = call.requireString("draftsFolder")
        val message = SmtpService.build(MailSessions.imap(account.imap), call.outgoingMessage(), requireRecipients = false)
        val uid = imap.append(account, folder, message, listOf("\\Draft", "\\Seen"))
        call.getLong("replaceUid")?.let { old ->
            try {
                imap.deleteMessages(account, folder, listOf(old))
            } catch (_: Throwable) {
                // An old draft left behind is harmless; the new one is saved.
            }
        }
        JSObject().put("uid", uid)
    }

    private fun safeFilename(name: String) =
        name.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().trimStart('.').ifEmpty { "file" }.take(120)
}
