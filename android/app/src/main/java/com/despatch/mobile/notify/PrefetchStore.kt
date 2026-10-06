package com.despatch.mobile.notify

import android.content.Context
import com.despatch.mobile.mail.CredentialStore
import java.io.File
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Newly notified messages, fetched in full by the background check so a
 * notification tap opens them without waiting for the network. Background work
 * can't write to the app's encrypted database, so each message is kept here,
 * AES-GCM encrypted with a Keystore key, until the app takes it into its
 * database. Only the newest [MAX_FILES] are kept.
 */
class PrefetchStore(private val dir: File, private val keyProvider: () -> SecretKey) {

    fun save(accountId: String, path: String, uid: Long, record: String) {
        dir.mkdirs()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider())
        val encrypted = cipher.doFinal(record.toByteArray(Charsets.UTF_8))
        // Written aside and renamed, so a reader never sees half a file.
        val target = fileFor(accountId, path, uid)
        val partial = File(dir, "${target.name}.tmp")
        partial.writeBytes(byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + encrypted)
        if (!partial.renameTo(target)) {
            target.delete()
            partial.renameTo(target)
        }
        prune()
    }

    fun remove(accountId: String, path: String, uid: Long) {
        fileFor(accountId, path, uid).delete()
    }

    /** Every saved record, oldest first, removing them. Ones that can't be decrypted are dropped. */
    fun takeAll(): List<String> {
        val files = saved().sortedBy { it.lastModified() }
        return files.mapNotNull { file ->
            try {
                val bytes = file.readBytes()
                val ivLength = bytes[0].toInt()
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(TAG_BITS, bytes, 1, ivLength))
                String(cipher.doFinal(bytes, 1 + ivLength, bytes.size - 1 - ivLength), Charsets.UTF_8)
            } catch (_: Exception) {
                null
            } finally {
                file.delete()
            }
        }
    }

    private fun saved() = dir.listFiles { file -> file.name.endsWith(SUFFIX) }?.toList() ?: emptyList()

    private fun prune() {
        saved().sortedByDescending { it.lastModified() }.drop(MAX_FILES).forEach { it.delete() }
    }

    private fun fileFor(accountId: String, path: String, uid: Long) =
        File(dir, UUID.nameUUIDFromBytes("$accountId\u0000$path\u0000$uid".toByteArray(Charsets.UTF_8)).toString() + SUFFIX)

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val KEY_ALIAS = "despatch.prefetch.v1"
        private const val SUFFIX = ".msg"
        const val MAX_FILES = 100

        fun forAndroid(context: Context) =
            PrefetchStore(File(context.noBackupFilesDir, "prefetch")) { CredentialStore.keystoreKey(KEY_ALIAS) }
    }
}
