package com.despatch.mobile.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.despatch.mobile.MainActivity
import com.despatch.mobile.R
import com.despatch.mobile.mail.CredentialStore
import com.despatch.mobile.mail.ImapService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Instant ("push") notifications (PLAN.md §4.4): a foreground service of type
 * remoteMessaging that holds IMAP IDLE on each account's Inbox. Android
 * requires its ongoing notification. Connections that drop are retried with
 * backoff (30 s, doubling to 15 min).
 */
class PushService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val checkLock = Mutex()
    @Volatile private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            ONGOING_ID,
            ongoingNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
        )
        if (!running) {
            running = true
            val store = BackgroundStore(this)
            for (account in store.accounts.filter { it.notify }) scope.launch { idleLoop(account) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun idleLoop(account: BackgroundAccount) {
        val imap = ImapService(CredentialStore.forAndroid(this))
        var backoff = INITIAL_BACKOFF_MS
        while (scope.isActive && running) {
            try {
                runInterruptible {
                    imap.idle(account.account, account.inboxPath, isActive = { running }) {
                        scope.launch { checkNow() }
                    }
                }
                backoff = INITIAL_BACKOFF_MS
            } catch (_: Exception) {
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
            }
        }
    }

    /** New mail signalled by IDLE: the same check (and notifications) as the periodic worker. */
    private suspend fun checkNow() = checkLock.withLock { SyncWorker.checkAll(this) }

    private fun ongoingNotification() = NotificationCompat.Builder(this, ensureServiceChannel())
        .setSmallIcon(R.drawable.ic_stat_mail)
        .setContentTitle("Instant notifications are on")
        .setContentText("Despatch Mobile is keeping a connection open for new mail.")
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .build()

    private fun ensureServiceChannel(): String {
        val channel = NotificationChannel(SERVICE_CHANNEL, "Instant notifications", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Shown while Despatch Mobile keeps a connection open for instant notifications."
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        return SERVICE_CHANNEL
    }

    companion object {
        private const val ONGOING_ID = 1
        private const val SERVICE_CHANNEL = "service"
        private const val INITIAL_BACKOFF_MS = 30_000L
        private const val MAX_BACKOFF_MS = 15 * 60_000L

        fun start(context: Context) {
            context.startForegroundService(Intent(context, PushService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PushService::class.java))
        }
    }
}
