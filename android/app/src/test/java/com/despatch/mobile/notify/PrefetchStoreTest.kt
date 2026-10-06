package com.despatch.mobile.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.KeyGenerator

class PrefetchStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private fun store() = PrefetchStore(folder.root.resolve("prefetch")) { key }

    @Test
    fun handsEachRecordOverOnce() {
        val store = store()
        store.save("a1", "INBOX", 7, """{"uid":7}""")
        store.save("a1", "INBOX", 8, """{"uid":8}""")
        assertEquals(setOf("""{"uid":7}""", """{"uid":8}"""), store.takeAll().toSet())
        assertTrue(store.takeAll().isEmpty())
    }

    @Test
    fun storesRecordsEncrypted() {
        store().save("a1", "INBOX", 7, "The Cheesecake Shop")
        val bytes = folder.root.resolve("prefetch").listFiles()!!.single().readBytes()
        assertFalse(String(bytes, Charsets.ISO_8859_1).contains("Cheesecake"))
    }

    @Test
    fun removesOneMessage() {
        val store = store()
        store.save("a1", "INBOX", 7, "seven")
        store.save("a1", "INBOX", 8, "eight")
        store.remove("a1", "INBOX", 7)
        assertEquals(listOf("eight"), store.takeAll())
    }

    @Test
    fun keepsOnlyTheNewest() {
        val store = store()
        for (uid in 1L..(PrefetchStore.MAX_FILES + 5L)) store.save("a1", "INBOX", uid, "m$uid")
        assertEquals(PrefetchStore.MAX_FILES, store.takeAll().size)
    }
}
