package com.despatch.mobile.mail

/**
 * Finds mail that arrived since the last check, for notifications (PLAN.md
 * §4.4). It works without the app's database: it only remembers, per account,
 * the Inbox UIDVALIDITY and the highest UID already notified (or seen in the
 * app). The first check records a starting point and reports nothing, so
 * existing mail never triggers notifications.
 */
class NewMailChecker(private val imap: ImapService, private val state: State) {

    data class Position(val uidValidity: Long, val lastUid: Long)

    interface State {
        fun position(accountId: String): Position?
        fun setPosition(accountId: String, position: Position)

        /** The Inbox's unread count from the same STATUS, for the app icon badge. */
        fun setUnread(accountId: String, unseen: Int) {}
    }

    /** New unread messages in [inboxPath], oldest first. */
    suspend fun check(account: AccountConfig, inboxPath: String): List<Envelope> {
        val status = imap.folderStatus(account, inboxPath)
        val saved = state.position(account.id)
        val newest = status.uidNext - 1
        state.setUnread(account.id, status.unseen)

        if (saved == null || saved.uidValidity != status.uidValidity) {
            state.setPosition(account.id, Position(status.uidValidity, newest))
            return emptyList()
        }
        if (newest <= saved.lastUid) return emptyList()

        // "n:*" also returns the newest message when nothing is above n, so filter.
        val arrived = imap.fetchEnvelopes(account, inboxPath, MessageQuery.UidRange(saved.lastUid + 1, null))
            .filter { it.uid > saved.lastUid }
        state.setPosition(account.id, Position(status.uidValidity, maxOf(newest, arrived.maxOfOrNull { it.uid } ?: 0)))
        return arrived.filter { "\\Seen" !in it.flags }
    }

    /** Called when the app has shown mail up to [uid], so it isn't notified again. */
    fun markSeen(accountId: String, uidValidity: Long, uid: Long) {
        val saved = state.position(accountId)
        if (saved == null || saved.uidValidity != uidValidity) {
            state.setPosition(accountId, Position(uidValidity, uid))
        } else if (uid > saved.lastUid) {
            state.setPosition(accountId, saved.copy(lastUid = uid))
        }
    }
}
