package com.despatch.mobile.notify

import android.content.Context
import com.despatch.mobile.mail.AccountConfig
import com.despatch.mobile.mail.NewMailChecker
import com.despatch.mobile.mail.accountFromJson
import org.json.JSONArray

/** One account as background checking needs it. The password stays in the CredentialStore. */
data class BackgroundAccount(
    val account: AccountConfig,
    val notify: Boolean,
    val inboxPath: String,
    val archivePath: String?,
    val accentColor: Int?,
    val label: String,
)

/**
 * What the app hands to background work (PLAN.md §4.4): the accounts to
 * check, how often, and whether instant ("push") mode is on, plus each
 * account's last notified UID. Stored in SharedPreferences, so background
 * work never needs the app's encrypted database.
 */
class BackgroundStore(context: Context) : NewMailChecker.State {
    private val prefs = context.getSharedPreferences("despatch_background", Context.MODE_PRIVATE)

    var accountsJson: String
        get() = prefs.getString("accounts", "[]") ?: "[]"
        set(value) = prefs.edit().putString("accounts", value).apply()

    var intervalMinutes: Int
        get() = prefs.getInt("intervalMinutes", 15)
        set(value) = prefs.edit().putInt("intervalMinutes", value).apply()

    var push: Boolean
        get() = prefs.getBoolean("push", false)
        set(value) = prefs.edit().putBoolean("push", value).apply()

    val accounts: List<BackgroundAccount>
        get() {
            val array = JSONArray(accountsJson)
            return List(array.length()) { index ->
                val item = array.getJSONObject(index)
                val account = accountFromJson(item.getJSONObject("account"))
                BackgroundAccount(
                    account = account,
                    notify = item.optBoolean("notify", true),
                    inboxPath = item.optString("inboxPath", "INBOX"),
                    archivePath = item.optString("archivePath").ifBlank { null },
                    accentColor = item.optString("accentColor").takeIf { it.matches(Regex("#[0-9a-fA-F]{6}")) }
                        ?.let { android.graphics.Color.parseColor(it) },
                    label = account.displayName?.takeIf { it.isNotBlank() } ?: account.email,
                )
            }
        }

    fun account(id: String) = accounts.firstOrNull { it.account.id == id }

    override fun position(accountId: String): NewMailChecker.Position? {
        val saved = prefs.getString("position.$accountId", null) ?: return null
        val (validity, uid) = saved.split(':').map { it.toLong() }
        return NewMailChecker.Position(validity, uid)
    }

    override fun setPosition(accountId: String, position: NewMailChecker.Position) {
        prefs.edit().putString("position.$accountId", "${position.uidValidity}:${position.lastUid}").apply()
    }
}
