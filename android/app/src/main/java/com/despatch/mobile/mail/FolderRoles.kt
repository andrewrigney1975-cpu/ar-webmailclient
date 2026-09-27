package com.despatch.mobile.mail

/**
 * Works out which folder is Sent, Drafts, Trash and so on. SPECIAL-USE
 * attributes (RFC 6154) win; common folder names are the fallback for servers
 * that don't advertise them.
 */
object FolderRoles {
    data class Candidate(val path: String, val name: String, val attributes: List<String>)

    private val attributeRoles = mapOf(
        "\\sent" to "sent",
        "\\drafts" to "drafts",
        "\\trash" to "trash",
        "\\junk" to "junk",
        "\\archive" to "archive",
        "\\all" to "all",
        "\\flagged" to "flagged",
    )

    private val nameRoles = mapOf(
        "sent" to "sent",
        "sent items" to "sent",
        "sent mail" to "sent",
        "sent messages" to "sent",
        "drafts" to "drafts",
        "draft" to "drafts",
        "trash" to "trash",
        "deleted items" to "trash",
        "deleted messages" to "trash",
        "bin" to "trash",
        "junk" to "junk",
        "junk e-mail" to "junk",
        "junk email" to "junk",
        "spam" to "junk",
        "bulk mail" to "junk",
        "archive" to "archive",
        "archives" to "archive",
    )

    /** Returns path → role for every folder that has one. Each role is assigned at most once. */
    fun assign(folders: List<Candidate>): Map<String, String> {
        val roles = mutableMapOf<String, String>()
        val taken = mutableSetOf<String>()

        folders.firstOrNull { it.path.equals("INBOX", ignoreCase = true) }?.let {
            roles[it.path] = "inbox"
            taken += "inbox"
        }

        for (folder in folders) {
            if (folder.path in roles) continue
            val role = folder.attributes.firstNotNullOfOrNull { attributeRoles[it.lowercase()] } ?: continue
            if (taken.add(role)) roles[folder.path] = role
        }

        for (folder in folders) {
            if (folder.path in roles) continue
            val role = nameRoles[folder.name.lowercase()] ?: continue
            if (taken.add(role)) roles[folder.path] = role
        }

        return roles
    }
}
