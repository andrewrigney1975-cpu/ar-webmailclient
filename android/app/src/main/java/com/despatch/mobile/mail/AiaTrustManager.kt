package com.despatch.mobile.mail

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Trust manager that completes chains from servers that don't send their
 * intermediate certificates, as desktop operating systems and browsers do.
 *
 * If the system trust manager rejects a chain, the issuer certificates named in
 * each certificate's Authority Information Access "CA Issuers" URL are
 * downloaded and the chain is verified again by the system trust manager. The
 * downloaded certificates are only path-building hints: the result must still
 * chain to a root the device trusts, and hostname checks are unaffected.
 */
class AiaTrustManager(
    private val system: X509TrustManager,
    private val fetch: (URI) -> ByteArray?,
) : X509TrustManager {
    // Failed downloads are cached as empty lists so they aren't retried on every connection.
    private val cache = ConcurrentHashMap<String, List<X509Certificate>>()
    private val trustedSubjects by lazy { system.acceptedIssuers.map { it.subjectX500Principal }.toSet() }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        try {
            system.checkServerTrusted(chain, authType)
        } catch (original: CertificateException) {
            val completed = completeChain(chain)
            if (completed.size == chain.size) throw original
            try {
                system.checkServerTrusted(completed.toTypedArray(), authType)
            } catch (_: CertificateException) {
                throw original
            }
        }
    }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
        system.checkClientTrusted(chain, authType)

    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers

    /** The server's chain plus any issuers fetched from AIA URLs (at most [MAX_FETCHES] levels). */
    fun completeChain(chain: Array<X509Certificate>): List<X509Certificate> {
        val result = chain.toMutableList()
        repeat(MAX_FETCHES) {
            val last = result.last()
            if (last.issuerX500Principal == last.subjectX500Principal) return result
            // The next issuer is a root the device already trusts: nothing left to fetch.
            if (last.issuerX500Principal in trustedSubjects) return result
            val issuers = caIssuerUrls(last).firstNotNullOfOrNull { url ->
                cache.getOrPut(url) { download(url).orEmpty() }.ifEmpty { null }
            } ?: return result
            val issuer = issuers.firstOrNull { it.subjectX500Principal == last.issuerX500Principal } ?: return result
            if (issuer in result) return result
            result += issuer
        }
        return result
    }

    private fun download(url: String): List<X509Certificate>? = try {
        val bytes = fetch(URI(url)) ?: return null
        CertificateFactory.getInstance("X.509")
            .generateCertificates(ByteArrayInputStream(bytes))
            .filterIsInstance<X509Certificate>()
            .takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val MAX_FETCHES = 3
        // A certificate (or small PKCS#7 bundle) plus HTTP headers.
        private const val MAX_BYTES = 64 * 1024
        private const val AIA_OID = "1.3.6.1.5.5.7.1.1"
        // DER encoding of the id-ad-caIssuers OID, 1.3.6.1.5.5.7.48.2.
        private val CA_ISSUERS = byteArrayOf(0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02)

        /** "CA Issuers" URLs from the certificate's Authority Information Access extension. */
        fun caIssuerUrls(certificate: X509Certificate): List<String> {
            val extension = certificate.getExtensionValue(AIA_OID) ?: return emptyList()
            return try {
                // OCTET STRING { SEQUENCE OF AccessDescription { OID, GeneralName } }
                val sequence = Der.read(Der.read(extension, 0).value, 0)
                Der.children(sequence.value).mapNotNull { description ->
                    val (method, location) = Der.children(description.value).takeIf { it.size == 2 } ?: return@mapNotNull null
                    // uniformResourceIdentifier is GeneralName [6], tag 0x86.
                    if (method.tag == 0x06 && method.value.contentEquals(CA_ISSUERS) && location.tag == 0x86) {
                        String(location.value, Charsets.US_ASCII).takeIf { it.startsWith("http://") || it.startsWith("https://") }
                    } else {
                        null
                    }
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

        fun systemTrustManager(): X509TrustManager {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(null as KeyStore?)
            return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        }

        /**
         * Downloads an issuer certificate. AIA URLs are nearly always plain HTTP,
         * which Android's HTTP stack refuses by default, so HTTP uses a minimal
         * HTTP/1.0 GET over a socket. Integrity doesn't depend on the transport:
         * the certificate's signature is verified when the chain is checked.
         */
        fun httpFetch(uri: URI, redirects: Int = 3): ByteArray? {
            if (uri.scheme == "https") {
                val connection = uri.toURL().openConnection() as HttpURLConnection
                return try {
                    connection.connectTimeout = MailSessions.CONNECT_TIMEOUT_MS
                    connection.readTimeout = MailSessions.CONNECT_TIMEOUT_MS
                    if (connection.responseCode != 200) null else connection.inputStream.use(::readLimited)
                } finally {
                    connection.disconnect()
                }
            }
            if (uri.scheme != "http" || uri.host.isNullOrEmpty()) return null

            val port = if (uri.port == -1) 80 else uri.port
            val response = Socket().use { socket ->
                socket.connect(InetSocketAddress(uri.host, port), MailSessions.CONNECT_TIMEOUT_MS)
                socket.soTimeout = MailSessions.CONNECT_TIMEOUT_MS
                val path = uri.rawPath.ifEmpty { "/" } + (uri.rawQuery?.let { "?$it" } ?: "")
                val request = "GET $path HTTP/1.0\r\nHost: ${uri.host}\r\nUser-Agent: Dispatch Mobile\r\nConnection: close\r\n\r\n"
                socket.getOutputStream().write(request.toByteArray(Charsets.US_ASCII))
                socket.getInputStream().use(::readLimited)
            } ?: return null

            val split = indexOf(response, "\r\n\r\n".toByteArray()).takeIf { it >= 0 } ?: return null
            val head = String(response, 0, split, Charsets.ISO_8859_1).split("\r\n")
            val status = head.first().split(' ').getOrNull(1)?.toIntOrNull() ?: return null
            if (status in 300..399 && redirects > 0) {
                val location = head.drop(1).firstOrNull { it.startsWith("location:", ignoreCase = true) }
                    ?.substringAfter(':')?.trim() ?: return null
                return httpFetch(uri.resolve(location), redirects - 1)
            }
            return if (status == 200) response.copyOfRange(split + 4, response.size) else null
        }

        private fun readLimited(input: InputStream): ByteArray? =
            input.readNBytes(MAX_BYTES + 1).takeIf { it.size <= MAX_BYTES }

        private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
            outer@ for (i in 0..haystack.size - needle.size) {
                for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
                return i
            }
            return -1
        }

        /** Socket factory for IMAP and SMTP: the system's trust store, plus AIA chain completion. */
        val socketFactory: SSLSocketFactory by lazy {
            val context = SSLContext.getInstance("TLS")
            context.init(null, arrayOf(AiaTrustManager(systemTrustManager(), ::httpFetch)), null)
            context.socketFactory
        }
    }

    /** Just enough DER to read the AIA extension. */
    private object Der {
        class Element(val tag: Int, val value: ByteArray, val end: Int)

        fun read(bytes: ByteArray, offset: Int): Element {
            val tag = bytes[offset].toInt() and 0xff
            var index = offset + 1
            var length = bytes[index++].toInt() and 0xff
            if (length and 0x80 != 0) {
                val count = length and 0x7f
                require(count in 1..3) { "Unsupported DER length" }
                length = 0
                repeat(count) { length = (length shl 8) or (bytes[index++].toInt() and 0xff) }
            }
            require(index + length <= bytes.size) { "Truncated DER" }
            return Element(tag, bytes.copyOfRange(index, index + length), index + length)
        }

        fun children(bytes: ByteArray): List<Element> {
            val items = mutableListOf<Element>()
            var offset = 0
            while (offset < bytes.size) {
                val element = read(bytes, offset)
                items += element
                offset = element.end
            }
            return items
        }
    }
}
