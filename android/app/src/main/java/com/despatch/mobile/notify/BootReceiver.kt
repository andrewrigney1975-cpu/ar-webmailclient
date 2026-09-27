package com.despatch.mobile.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts instant notifications after a reboot. (WorkManager restores the periodic check itself.) */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val store = BackgroundStore(context)
        if (store.push && store.accounts.any { it.notify }) {
            try {
                PushService.start(context)
            } catch (_: Exception) {
                // Android may refuse a foreground service at boot; the periodic check still runs.
            }
        }
    }
}
