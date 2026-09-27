package com.despatch.mobile.mail

import jakarta.mail.Multipart
import jakarta.mail.Part
import jakarta.mail.internet.MimeUtility
import java.io.UnsupportedEncodingException

/**
 * Walks a message's MIME tree. For IMAP messages the tree comes from
 * BODYSTRUCTURE, so walking it (and checking for attachments) doesn't
 * download any content.
 *
 * Part IDs follow IMAP section numbering: a single-part message is "1", and
 * the children of a multipart are "1", "2", ... with nested levels joined by
 * dots ("1.2").
 */
object MimeParts {
    enum class Kind { TEXT_BODY, HTML_BODY, INLINE, ATTACHMENT, CONTAINER }

    data class Leaf(val partId: String, val part: Part, val kind: Kind)

    fun leaves(message: Part): List<Leaf> {
        val result = mutableListOf<Leaf>()
        if (message.isMimeType("multipart/*")) {
            walkMultipart(message.content as Multipart, "", result)
        } else {
            result += Leaf("1", message, classify(message))
        }
        return result
    }

    private fun walkMultipart(multipart: Multipart, prefix: String, out: MutableList<Leaf>) {
        for (i in 0 until multipart.count) {
            val part = multipart.getBodyPart(i)
            val id = if (prefix.isEmpty()) "${i + 1}" else "$prefix.${i + 1}"
            if (part.isMimeType("multipart/*")) {
                walkMultipart(part.content as Multipart, id, out)
            } else {
                out += Leaf(id, part, classify(part))
            }
        }
    }

    fun classify(part: Part): Kind {
        val disposition = part.disposition?.lowercase()
        val filename = filenameOf(part)
        val contentId = (part as? jakarta.mail.internet.MimePart)?.contentID

        return when {
            part.isMimeType("multipart/*") -> Kind.CONTAINER
            disposition == Part.ATTACHMENT -> Kind.ATTACHMENT
            // A forwarded email is shown as an attachment rather than inlined.
            part.isMimeType("message/rfc822") -> Kind.ATTACHMENT
            filename == null && part.isMimeType("text/plain") -> Kind.TEXT_BODY
            filename == null && part.isMimeType("text/html") -> Kind.HTML_BODY
            contentId != null && disposition != Part.ATTACHMENT -> Kind.INLINE
            else -> Kind.ATTACHMENT
        }
    }

    fun hasAttachments(message: Part): Boolean = leaves(message).any { it.kind == Kind.ATTACHMENT }

    fun find(message: Part, partId: String): Part? = leaves(message).firstOrNull { it.partId == partId }?.part

    fun filenameOf(part: Part): String? = try {
        part.fileName?.let { MimeUtility.decodeText(it) }
    } catch (_: Exception) {
        part.fileName
    }

    /** Text content of a text part, tolerating unknown or broken charsets. */
    fun textOf(part: Part): String? = try {
        part.content as? String
    } catch (_: UnsupportedEncodingException) {
        part.inputStream.use { String(it.readBytes(), Charsets.UTF_8) }
    }

    fun attachmentInfo(leaf: Leaf): AttachmentInfo {
        val part = leaf.part
        val mimeType = part.contentType?.substringBefore(';')?.trim()?.lowercase() ?: "application/octet-stream"
        return AttachmentInfo(
            partId = leaf.partId,
            filename = filenameOf(part),
            mimeType = mimeType,
            size = part.size,
            contentId = (part as? jakarta.mail.internet.MimePart)?.contentID?.trim('<', '>', ' '),
            inline = leaf.kind == Kind.INLINE,
        )
    }
}
