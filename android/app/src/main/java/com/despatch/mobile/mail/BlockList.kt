package com.despatch.mobile.mail

/**
 * Senders and domains the user blocked. Their new mail goes straight to Trash
 * without a notification. A blocked domain also covers its subdomains, so
 * blocking "example.com" catches "news.example.com".
 */
data class BlockList(val addresses: Set<String>, val domains: Set<String>) {

    fun blocks(address: String?): Boolean {
        val email = address?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
        if (email in addresses) return true
        val domain = email.substringAfterLast('@', "")
        return domain.isNotEmpty() && domains.any { domain == it || domain.endsWith(".$it") }
    }

    fun blocks(envelope: Envelope) = envelope.from.any { blocks(it.address) }

    companion object {
        val EMPTY = BlockList(emptySet(), emptySet())

        fun of(addresses: Collection<String>, domains: Collection<String>) = BlockList(
            addresses.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet(),
            domains.map { it.trim().lowercase().removePrefix("@") }.filter { it.isNotEmpty() }.toSet(),
        )
    }
}
