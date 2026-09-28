package com.despatch.mobile.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast
import com.despatch.mobile.mail.CredentialStore
import com.despatch.mobile.mail.ImapService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Handles Mark read and Archive from a notification, straight on the server,
 * and keeps the app icon badge in step when one is acted on or swiped away.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val accountId = intent.getStringExtra(MailNotifier.EXTRA_ACCOUNT) ?: return
        val uid = intent.getLongExtra(MailNotifier.EXTRA_UID, -1).takeIf { it > 0 } ?: return
        val store = BackgroundStore(context)
        val account = store.account(accountId) ?: return
        val notifier = MailNotifier(context)
        if (intent.action == DISMISSED) {
            notifier.updateBadge(store.badgeCount)
            return
        }
        val pending = goAsync()

        CoroutineScope(Dispatchers.IO).launch {
            val imap = ImapService(CredentialStore.forAndroid(context))
            try {
                when (intent.action) {
                    MARK_READ -> imap.setFlags(account.account, account.inboxPath, listOf(uid), listOf("\\Seen"), emptyList())
                    ARCHIVE -> account.archivePath?.let {
                        imap.moveMessages(account.account, account.inboxPath, listOf(uid), it)
                    }
                }
                notifier.cancel(accountId, uid)
                // Notified mail is unread, so either action takes one off the Inbox count.
                store.setUnread(accountId, store.unread(accountId) - 1)
                notifier.updateBadge(store.badgeCount)
            } catch (_: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(context, "Couldn’t update the message. Try again in the app.", Toast.LENGTH_SHORT).show()
                }
            } finally {
                imap.disconnectAll()
                pending.finish()
            }
        }
    }

    companion object {
        const val MARK_READ = "com.despatch.mobile.action.MARK_READ"
        const val ARCHIVE = "com.despatch.mobile.action.ARCHIVE"
        const val DISMISSED = "com.despatch.mobile.action.DISMISSED"
    }
}
