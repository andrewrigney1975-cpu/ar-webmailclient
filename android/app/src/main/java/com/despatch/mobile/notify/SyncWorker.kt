package com.despatch.mobile.notify

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.despatch.mobile.MainActivity
import com.despatch.mobile.mail.CredentialStore
import com.despatch.mobile.mail.Envelope
import com.despatch.mobile.mail.ImapService
import com.despatch.mobile.mail.MailErrors
import com.despatch.mobile.mail.NewMailChecker
import com.despatch.mobile.mail.toJs
import com.getcapacitor.JSObject
import java.util.concurrent.TimeUnit

/**
 * Periodic background check for new mail while the app isn't open (PLAN.md
 * §4.4). WorkManager runs it at most every 15 minutes, only with a network,
 * and keeps the schedule across reboots.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        checkAll(applicationContext, trigger = "scheduled")
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "despatch.mail-check"

        /** Checks every account with notifications on, and notifies unless the app is on screen. */
        suspend fun checkAll(context: Context, trigger: String) {
            val store = BackgroundStore(context)
            val imap = ImapService(CredentialStore.forAndroid(context))
            val checker = NewMailChecker(imap, store)
            val notifier = MailNotifier(context)
            val blockList = store.blockList
            val prefetch = PrefetchStore.forAndroid(context)
            var found = 0
            val errors = mutableListOf<String>()
            try {
                for (account in store.accounts.filter { it.notify }) {
                    try {
                        val (blocked, arrived) = checker.check(account.account, account.inboxPath).partition { blockList.blocks(it) }
                        trashBlocked(imap, store, account, blocked)
                        found += arrived.size
                        if (!MainActivity.isVisible && arrived.isNotEmpty()) {
                            notifier.notifyNewMail(account, arrived)
                            prefetchMessages(imap, store, prefetch, account, arrived)
                        }
                    } catch (error: Exception) {
                        // One account failing (password changed, server down) mustn't stop the others.
                        errors += "${account.account.email}: ${MailErrors.classify(error).message}"
                    }
                }
            } finally {
                imap.disconnectAll()
                notifier.updateBadge(store.badgeCount)
                store.recordCheck(trigger, found, errors.joinToString("; ").ifEmpty { null })
            }
        }

        /** Mail from blocked senders goes straight to Trash, unannounced. */
        private suspend fun trashBlocked(imap: ImapService, store: BackgroundStore, account: BackgroundAccount, blocked: List<Envelope>) {
            val trash = account.trashPath ?: return
            if (blocked.isEmpty()) return
            try {
                imap.moveMessages(account.account, account.inboxPath, blocked.map { it.uid }, trash)
                // check() only returns unread mail, so each one leaves the Inbox unread count.
                store.setUnread(account.account.id, store.unread(account.account.id) - blocked.size)
            } catch (_: Exception) {
                // The app moves them on its next sync.
            }
        }

        /**
         * Fetches each notified message in full and keeps it for the app, so
         * tapping the notification opens it at once (the app takes these into
         * its database with takePrefetched).
         */
        private suspend fun prefetchMessages(
            imap: ImapService,
            store: BackgroundStore,
            prefetch: PrefetchStore,
            account: BackgroundAccount,
            envelopes: List<Envelope>,
        ) {
            val uidValidity = store.position(account.account.id)?.uidValidity ?: return
            for (envelope in envelopes) {
                try {
                    val body = imap.fetchBody(account.account, account.inboxPath, envelope.uid)
                    val record = JSObject()
                        .put("accountId", account.account.id)
                        .put("path", account.inboxPath)
                        .put("uidValidity", uidValidity)
                        .put("envelope", envelope.toJs())
                        .put("body", body.toJs())
                    prefetch.save(account.account.id, account.inboxPath, envelope.uid, record.toString())
                } catch (_: Exception) {
                    // The app fetches it when opened instead.
                }
            }
        }

        /**
         * Schedules the periodic check. The app calls this on every start, so an
         * existing schedule is kept (replacing it would restart the countdown each
         * time the app opens); it's only replaced when the interval changes.
         */
        fun schedule(context: Context, intervalMinutes: Int) {
            val minutes = intervalMinutes.coerceAtLeast(15)
            val store = BackgroundStore(context)
            val policy = if (store.scheduledIntervalMinutes == minutes) {
                ExistingPeriodicWorkPolicy.KEEP
            } else {
                ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE
            }
            val request = PeriodicWorkRequestBuilder<SyncWorker>(minutes.toLong(), TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, policy, request)
            store.scheduledIntervalMinutes = minutes
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
            BackgroundStore(context).scheduledIntervalMinutes = 0
        }
    }
}
