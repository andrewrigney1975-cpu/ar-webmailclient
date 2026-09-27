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
import com.despatch.mobile.mail.ImapService
import com.despatch.mobile.mail.MailErrors
import com.despatch.mobile.mail.NewMailChecker
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
            var found = 0
            val errors = mutableListOf<String>()
            try {
                for (account in store.accounts.filter { it.notify }) {
                    try {
                        val arrived = checker.check(account.account, account.inboxPath)
                        found += arrived.size
                        if (!MainActivity.isVisible) notifier.notifyNewMail(account, arrived)
                    } catch (error: Exception) {
                        // One account failing (password changed, server down) mustn't stop the others.
                        errors += "${account.account.email}: ${MailErrors.classify(error).message}"
                    }
                }
            } finally {
                imap.disconnectAll()
                store.recordCheck(trigger, found, errors.joinToString("; ").ifEmpty { null })
            }
        }

        fun schedule(context: Context, intervalMinutes: Int) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(intervalMinutes.coerceAtLeast(15).toLong(), TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
