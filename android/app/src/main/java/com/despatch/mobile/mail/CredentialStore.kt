package com.despatch.mobile.mail

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores account passwords encrypted with AES-GCM. On a device the key lives
 * in the Android Keystore and never leaves it; passwords are only decrypted in
 * native code and are never returned to JavaScript.
 */
class CredentialStore(
    private val storage: KeyValueStorage,
    private val keyProvider: () -> SecretKey,
) : PasswordSource {

    interface KeyValueStorage {
        fun get(key: String): String?
        fun put(key: String, value: String)
        fun remove(key: String)
    }

    fun save(accountId: String, password: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider())
        val encrypted = cipher.doFinal(password.toByteArray(Charsets.UTF_8))
        storage.put(keyFor(accountId), "${encode(cipher.iv)}:${encode(encrypted)}")
    }

    fun delete(accountId: String) = storage.remove(keyFor(accountId))

    fun has(accountId: String) = storage.get(keyFor(accountId)) != null

    /** Returns null when nothing is stored or it can no longer be decrypted (e.g. the key was reset). */
    override fun passwordFor(accountId: String): String? {
        val stored = storage.get(keyFor(accountId)) ?: return null
        return try {
            val (iv, encrypted) = stored.split(':', limit = 2).map { Base64.getDecoder().decode(it) }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    private fun keyFor(accountId: String) = "password.$accountId"

    private fun encode(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val KEY_ALIAS = "despatch.credentials.v1"
        private const val PREFS_NAME = "despatch_credentials"

        fun forAndroid(context: Context): CredentialStore {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val storage = object : KeyValueStorage {
                override fun get(key: String) = prefs.getString(key, null)
                override fun put(key: String, value: String) {
                    prefs.edit().putString(key, value).apply()
                }
                override fun remove(key: String) {
                    prefs.edit().remove(key).apply()
                }
            }
            return CredentialStore(storage) { keystoreKey(KEY_ALIAS) }
        }

        /** An AES-GCM key held in the Android Keystore, created on first use. */
        fun keystoreKey(alias: String): SecretKey {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generator.init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return generator.generateKey()
        }
    }
}
