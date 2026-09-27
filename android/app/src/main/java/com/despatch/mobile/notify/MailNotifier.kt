package com.despatch.mobile.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.despatch.mobile.MainActivity
import com.despatch.mobile.R
import com.despatch.mobile.mail.Envelope

/**
 * New-mail notifications (PLAN.md §4.4): a channel per account (so users can
 * tune each in system settings), coloured with the account accent, grouped
 * per account, with Mark read, Archive and Reply actions.
 */
class MailNotifier(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannel(account: BackgroundAccount): String {
        val id = channelId(account.account.id)
        val channel = NotificationChannel(id, account.label, NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "New mail for ${account.account.email}"
            account.accentColor?.let {
                enableLights(true)
                lightColor = it
            }
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        return id
    }

    fun removeChannelsExcept(accountIds: Set<String>) {
        val system = context.getSystemService(NotificationManager::class.java)
        system.notificationChannels
            .filter { it.id.startsWith(CHANNEL_PREFIX) && it.id.removePrefix(CHANNEL_PREFIX) !in accountIds }
            .forEach { system.deleteNotificationChannel(it.id) }
    }

    fun notifyNewMail(account: BackgroundAccount, envelopes: List<Envelope>) {
        if (envelopes.isEmpty() || !manager.areNotificationsEnabled()) return
        val channel = ensureChannel(account)
        val group = "mail.${account.account.id}"

        for (envelope in envelopes) {
            val sender = envelope.from.firstOrNull()?.let { it.name ?: it.address } ?: "Unknown sender"
            val id = notificationId(account.account.id, envelope.uid)
            val builder = NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_stat_mail)
                .setContentTitle(sender)
                .setContentText(envelope.subject ?: "(no subject)")
                .setSubText(account.account.email)
                .setWhen(envelope.dateReceived ?: System.currentTimeMillis())
                .setShowWhen(true)
                .setCategory(NotificationCompat.CATEGORY_EMAIL)
                .setGroup(group)
                .setAutoCancel(true)
                .setContentIntent(openIntent(account, envelope.uid, id, MainActivity.ACTION_OPEN_MESSAGE))
                .addAction(0, "Mark read", actionIntent(account, envelope.uid, id, NotificationActionReceiver.MARK_READ))
            account.accentColor?.let { builder.setColor(it) }
            if (account.archivePath != null) {
                builder.addAction(0, "Archive", actionIntent(account, envelope.uid, id, NotificationActionReceiver.ARCHIVE))
            }
            builder.addAction(0, "Reply", openIntent(account, envelope.uid, id + 1, MainActivity.ACTION_REPLY))
            manager.notify(id, builder.build())
        }

        val summary = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_mail)
            .setStyle(
                NotificationCompat.InboxStyle().also { style ->
                    envelopes.takeLast(5).forEach { e ->
                        style.addLine("${e.from.firstOrNull()?.let { it.name ?: it.address } ?: ""}  ${e.subject ?: ""}")
                    }
                    style.setSummaryText(account.account.email)
                },
            )
            .setGroup(group)
            .setGroupSummary(true)
            .setAutoCancel(true)
        account.accentColor?.let { summary.setColor(it) }
        manager.notify(summaryId(account.account.id), summary.build())
    }

    fun cancel(accountId: String, uid: Long) = manager.cancel(notificationId(accountId, uid))

    /** Clears an account's notifications, e.g. when the app shows its inbox. */
    fun cancelAccount(accountId: String) {
        val system = context.getSystemService(NotificationManager::class.java)
        val group = "mail.$accountId"
        system.activeNotifications.filter { it.notification.group == group }.forEach { manager.cancel(it.id) }
    }

    private fun openIntent(account: BackgroundAccount, uid: Long, requestCode: Int, action: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_ACCOUNT, account.account.id)
            .putExtra(EXTRA_PATH, account.inboxPath)
            .putExtra(EXTRA_UID, uid)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(account: BackgroundAccount, uid: Long, notificationId: Int, action: String): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java)
            .setAction(action)
            .putExtra(EXTRA_ACCOUNT, account.account.id)
            .putExtra(EXTRA_UID, uid)
            .putExtra(EXTRA_NOTIFICATION, notificationId)
        return PendingIntent.getBroadcast(
            context,
            notificationId * 4 + action.hashCode().mod(4),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val CHANNEL_PREFIX = "mail."
        const val EXTRA_ACCOUNT = "despatch.accountId"
        const val EXTRA_PATH = "despatch.path"
        const val EXTRA_UID = "despatch.uid"
        const val EXTRA_NOTIFICATION = "despatch.notificationId"

        fun channelId(accountId: String) = "$CHANNEL_PREFIX$accountId"

        // Even IDs for messages, odd (id + 1) for their Reply intents.
        fun notificationId(accountId: String, uid: Long) = ((accountId.hashCode() * 31 + uid.hashCode()) and 0x3FFFFFFE)

        fun summaryId(accountId: String) = accountId.hashCode() or 1
    }
}
