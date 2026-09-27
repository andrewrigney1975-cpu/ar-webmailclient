package com.despatch.mobile.mail

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.json.JSONArray
import org.json.JSONObject

/* Conversion between plugin call arguments / results and the mail models. */

fun PluginCall.requireString(name: String): String =
    getString(name)?.takeIf { it.isNotBlank() }
        ?: throw MailException(MailErrorCode.INVALID_ARGUMENT, "Missing argument: $name")

fun PluginCall.requireLong(name: String): Long =
    getLong(name) ?: getInt(name)?.toLong()
        ?: throw MailException(MailErrorCode.INVALID_ARGUMENT, "Missing argument: $name")

fun PluginCall.requireAccount(): AccountConfig {
    val json = getObject("account") ?: throw MailException(MailErrorCode.INVALID_ARGUMENT, "Missing argument: account")
    return AccountConfig(
        id = json.requireString("id"),
        email = json.requireString("email"),
        displayName = json.optString("displayName").ifBlank { null },
        imap = serverConfig(json.optJSONObject("imap") ?: missing("account.imap")),
        smtp = json.optJSONObject("smtp")?.let(::serverConfig),
    )
}

fun PluginCall.longList(name: String): List<Long> = getArray(name)?.let { array ->
    List(array.length()) { array.getLong(it) }
} ?: emptyList()

fun PluginCall.stringList(name: String): List<String> = getArray(name)?.let { array ->
    List(array.length()) { array.getString(it) }
} ?: emptyList()

fun PluginCall.messageQuery(): MessageQuery {
    val query = getObject("query") ?: missing("query")
    return when {
        query.has("uids") -> {
            val uids = query.getJSONArray("uids")
            MessageQuery.ByUids(List(uids.length()) { uids.getLong(it) })
        }
        query.has("fromUid") -> MessageQuery.UidRange(
            fromUid = query.getLong("fromUid"),
            toUid = if (query.isNull("toUid")) null else query.optLong("toUid"),
        )
        query.has("latest") -> MessageQuery.Latest(query.getInt("latest"))
        else -> throw MailException(MailErrorCode.INVALID_ARGUMENT, "query needs uids, fromUid or latest")
    }
}

fun PluginCall.searchCriteria(): SearchCriteria {
    val json = getObject("criteria") ?: missing("criteria")
    fun strings(name: String) = json.optJSONArray(name)?.let { array -> List(array.length()) { array.getString(it) } } ?: emptyList()
    fun long(name: String) = if (json.isNull(name) || !json.has(name)) null else json.getLong(name)
    fun bool(name: String) = if (json.isNull(name) || !json.has(name)) null else json.getBoolean(name)
    return SearchCriteria(
        text = strings("text"),
        from = strings("from"),
        to = strings("to"),
        subject = strings("subject"),
        unread = bool("unread"),
        flagged = bool("flagged"),
        before = long("before"),
        after = long("after"),
        larger = long("larger")?.toInt(),
        smaller = long("smaller")?.toInt(),
    )
}

fun PluginCall.outgoingMessage(): OutgoingMessage {
    val json = getObject("message") ?: missing("message")
    return OutgoingMessage(
        from = address(json.optJSONObject("from") ?: missing("message.from")),
        to = addresses(json.optJSONArray("to")),
        cc = addresses(json.optJSONArray("cc")),
        bcc = addresses(json.optJSONArray("bcc")),
        replyTo = addresses(json.optJSONArray("replyTo")),
        subject = json.optString("subject"),
        text = json.optNullableString("text"),
        html = json.optNullableString("html"),
        inReplyTo = json.optNullableString("inReplyTo"),
        references = json.optJSONArray("references")?.let { array -> List(array.length()) { array.getString(it) } }
            ?: emptyList(),
        attachments = json.optJSONArray("attachments")?.let { array ->
            List(array.length()) {
                val item = array.getJSONObject(it)
                OutgoingAttachment(
                    filename = item.requireString("filename"),
                    mimeType = item.optString("mimeType").ifBlank { "application/octet-stream" },
                    path = item.requireString("path"),
                )
            }
        } ?: emptyList(),
    )
}

private fun serverConfig(json: JSONObject) = ServerConfig(
    host = json.requireString("host"),
    port = json.optInt("port").takeIf { it in 1..65535 } ?: missing("port"),
    security = Security.parse(json.optString("security")),
    username = json.requireString("username"),
)

private fun address(json: JSONObject) = MailAddress(json.optNullableString("name"), json.requireString("address"))

private fun addresses(array: JSONArray?): List<MailAddress> =
    array?.let { List(it.length()) { index -> address(it.getJSONObject(index)) } } ?: emptyList()

private fun JSONObject.requireString(name: String): String =
    optString(name).takeIf { it.isNotBlank() } ?: missing(name)

private fun JSONObject.optNullableString(name: String): String? =
    if (isNull(name)) null else optString(name).ifEmpty { null }

private fun missing(name: String): Nothing =
    throw MailException(MailErrorCode.INVALID_ARGUMENT, "Missing argument: $name")

// --- Results -------------------------------------------------------------------------------

fun MailAddress.toJs() = JSObject().put("name", name).put("address", address)

private fun List<MailAddress>.toJs() = JSArray().also { array -> forEach { array.put(it.toJs()) } }

private fun List<String>.toJsStrings() = JSArray().also { array -> forEach { array.put(it) } }

fun FolderInfo.toJs(): JSObject = JSObject()
    .put("path", path)
    .put("name", name)
    .put("delimiter", delimiter)
    .put("role", role)
    .put("attributes", attributes.toJsStrings())
    .put("subscribed", subscribed)
    .put("selectable", selectable)

fun FolderStatus.toJs(): JSObject = JSObject()
    .put("path", path)
    .put("uidValidity", uidValidity)
    .put("uidNext", uidNext)
    .put("highestModSeq", highestModSeq)
    .put("messages", messages)
    .put("unseen", unseen)

fun Envelope.toJs(): JSObject = JSObject()
    .put("uid", uid)
    .put("messageId", messageId)
    .put("inReplyTo", inReplyTo)
    .put("references", references.toJsStrings())
    .put("subject", subject)
    .put("from", from.toJs())
    .put("to", to.toJs())
    .put("cc", cc.toJs())
    .put("replyTo", replyTo.toJs())
    .put("dateSent", dateSent)
    .put("dateReceived", dateReceived)
    .put("size", size)
    .put("flags", flags.toJsStrings())
    .put("hasAttachments", hasAttachments)

fun MessageFlags.toJs(): JSObject = JSObject().put("uid", uid).put("flags", flags.toJsStrings())

fun AttachmentInfo.toJs(): JSObject = JSObject()
    .put("partId", partId)
    .put("filename", filename)
    .put("mimeType", mimeType)
    .put("size", size)
    .put("contentId", contentId)
    .put("inline", inline)

fun MessageBody.toJs(): JSObject = JSObject()
    .put("uid", uid)
    .put("text", text)
    .put("html", html)
    .put("attachments", JSArray().also { array -> attachments.forEach { array.put(it.toJs()) } })

fun <T> List<T>.toJsArray(convert: (T) -> JSObject) = JSArray().also { array -> forEach { array.put(convert(it)) } }
