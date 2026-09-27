package com.despatch.mobile.mail

import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.AccessDescription
import org.bouncycastle.asn1.x509.AuthorityInformationAccess
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigInteger
import java.net.ServerSocket
import java.net.URI
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

class AiaTrustManagerTest {
    private class Issued(val certificate: X509Certificate, val keys: KeyPair)

    private val keyGenerator = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }
    private var serial = 1L

    private fun issue(subject: String, issuer: Issued?, ca: Boolean, aiaUrl: String? = null): Issued {
        val keys = keyGenerator.generateKeyPair()
        val signer = issuer?.keys ?: keys
        val builder = JcaX509v3CertificateBuilder(
            X500Name(issuer?.certificate?.subjectX500Principal?.name ?: subject),
            BigInteger.valueOf(serial++),
            Date(System.currentTimeMillis() - 86_400_000),
            Date(System.currentTimeMillis() + 86_400_000),
            X500Name(subject),
            keys.public,
        )
        builder.addExtension(Extension.basicConstraints, true, BasicConstraints(ca))
        if (aiaUrl != null) {
            builder.addExtension(
                Extension.authorityInfoAccess,
                false,
                AuthorityInformationAccess(
                    AccessDescription(AccessDescription.id_ad_caIssuers, GeneralName(GeneralName.uniformResourceIdentifier, aiaUrl)),
                ),
            )
        }
        val certificate = JcaX509CertificateConverter()
            .getCertificate(builder.build(JcaContentSignerBuilder("SHA256withRSA").build(signer.private)))
        return Issued(certificate, keys)
    }

    private fun trusting(root: X509Certificate): X509TrustManager {
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setCertificateEntry("root", root)
        }
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(store)
        return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    private val root = issue("CN=Test Root", null, ca = true)
    private val intermediate = issue("CN=Test Intermediate", root, ca = true, aiaUrl = "http://ca.test/root.crt")
    private val leaf = issue("CN=mail.example.test", intermediate, ca = false, aiaUrl = "http://ca.test/intermediate.crt")
    private val system = trusting(root.certificate)

    @Test
    fun readsCaIssuerUrls() {
        assertEquals(listOf("http://ca.test/intermediate.crt"), AiaTrustManager.caIssuerUrls(leaf.certificate))
        assertEquals(emptyList<String>(), AiaTrustManager.caIssuerUrls(root.certificate))
    }

    @Test
    fun completesAChainMissingItsIntermediate() {
        try {
            system.checkServerTrusted(arrayOf(leaf.certificate), "RSA")
            fail("The system trust manager should reject the incomplete chain")
        } catch (_: CertificateException) {
        }

        val fetched = mutableListOf<URI>()
        val manager = AiaTrustManager(system) { uri ->
            fetched += uri
            if (uri.toString() == "http://ca.test/intermediate.crt") intermediate.certificate.encoded else null
        }

        manager.checkServerTrusted(arrayOf(leaf.certificate), "RSA")
        manager.checkServerTrusted(arrayOf(leaf.certificate), "RSA")

        assertEquals("fetched once, then cached", listOf(URI("http://ca.test/intermediate.crt")), fetched)
    }

    @Test
    fun rejectsIssuersThatDontChainToATrustedRoot() {
        val otherRoot = issue("CN=Attacker Root", null, ca = true)
        val forged = issue("CN=Test Intermediate", otherRoot, ca = true)
        val manager = AiaTrustManager(system) { forged.certificate.encoded }

        try {
            manager.checkServerTrusted(arrayOf(leaf.certificate), "RSA")
            fail("A forged intermediate must not be accepted")
        } catch (_: CertificateException) {
        }
    }

    @Test
    fun rejectsWhenNothingCanBeFetched() {
        val manager = AiaTrustManager(system) { null }
        try {
            manager.checkServerTrusted(arrayOf(leaf.certificate), "RSA")
            fail("Expected rejection")
        } catch (_: CertificateException) {
        }
    }

    @Test
    fun leavesCompleteChainsAlone() {
        val manager = AiaTrustManager(system) { fail("should not fetch"); null }
        manager.checkServerTrusted(arrayOf(leaf.certificate, intermediate.certificate), "RSA")
    }

    @Test
    fun fetchesOverPlainHttpAndFollowsRedirects() {
        val body = intermediate.certificate.encoded
        ServerSocket(0).use { server ->
            val port = server.localPort
            val worker = thread {
                repeat(2) {
                    server.accept().use { socket ->
                        val request = socket.getInputStream().bufferedReader().readLine()
                        val out = socket.getOutputStream()
                        if (request.startsWith("GET /old ")) {
                            out.write("HTTP/1.0 301 Moved\r\nLocation: /new.crt\r\n\r\n".toByteArray())
                        } else {
                            out.write("HTTP/1.0 200 OK\r\nContent-Type: application/pkix-cert\r\n\r\n".toByteArray())
                            out.write(body)
                        }
                    }
                }
            }
            val bytes = AiaTrustManager.httpFetch(URI("http://127.0.0.1:$port/old"))
            worker.join(5_000)
            assertArrayEquals(body, bytes)
        }
    }

    @Test
    fun refusesNonHttpUrls() {
        assertNull(AiaTrustManager.httpFetch(URI("ldap://ca.test/cert")))
        assertTrue(AiaTrustManager.caIssuerUrls(intermediate.certificate).all { it.startsWith("http") })
    }
}
