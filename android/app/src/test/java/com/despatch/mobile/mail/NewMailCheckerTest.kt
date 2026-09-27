package com.despatch.mobile.mail

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class NewMailCheckerTest {
    private lateinit var server: TestMailServer
    private lateinit var imap: ImapService
    private val positions = mutableMapOf<String, NewMailChecker.Position>()
    private val state = object : NewMailChecker.State {
        override fun position(accountId: String) = positions[accountId]
        override fun setPosition(accountId: String, position: NewMailChecker.Position) {
            positions[accountId] = position
        }
    }

    @Before
    fun setUp() {
        server = TestMailServer()
        imap = ImapService(server.passwords)
    }

    @After
    fun tearDown() {
        imap.disconnectAll()
        server.close()
    }

    @Test
    fun startsQuietlyThenReportsOnlyNewUnreadMail() = runBlocking<Unit> {
        val checker = NewMailChecker(imap, state)
        server.deliver(TestMailServer.message("Old news"))

        assertTrue("existing mail is never notified", checker.check(server.account, "INBOX").isEmpty())
        assertTrue(checker.check(server.account, "INBOX").isEmpty())

        server.deliver(TestMailServer.message("Fresh one"))
        server.deliver(TestMailServer.message("Fresh two"))
        assertEquals(listOf("Fresh one", "Fresh two"), checker.check(server.account, "INBOX").map { it.subject })
        assertTrue("reported once only", checker.check(server.account, "INBOX").isEmpty())
    }

    @Test
    fun skipsMailAlreadyReadOrSeenInTheApp() = runBlocking<Unit> {
        val checker = NewMailChecker(imap, state)
        checker.check(server.account, "INBOX")

        server.deliver(TestMailServer.message("Read on the desktop"))
        val read = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(1)).single()
        imap.setFlags(server.account, "INBOX", listOf(read.uid), add = listOf("\\Seen"), remove = emptyList())
        assertTrue(checker.check(server.account, "INBOX").isEmpty())

        server.deliver(TestMailServer.message("Seen in the app"))
        val seen = imap.fetchEnvelopes(server.account, "INBOX", MessageQuery.Latest(1)).single()
        checker.markSeen(server.account.id, imap.folderStatus(server.account, "INBOX").uidValidity, seen.uid)
        assertTrue(checker.check(server.account, "INBOX").isEmpty())
    }

    @Test
    fun startsAgainWhenUidValidityChanges() = runBlocking<Unit> {
        val checker = NewMailChecker(imap, state)
        checker.check(server.account, "INBOX")
        positions[server.account.id] = positions.getValue(server.account.id).copy(uidValidity = -1)

        server.deliver(TestMailServer.message("After a mailbox rebuild"))
        assertTrue("a new baseline, not a flood of old mail", checker.check(server.account, "INBOX").isEmpty())
    }
}
