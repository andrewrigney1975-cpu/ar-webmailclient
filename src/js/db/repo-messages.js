/** Cached message envelopes (and, once fetched, bodies). */

const SORTS = {
  dateReceived: 'm.date_received',
  dateSent: 'm.date_sent',
  sender: "LOWER(COALESCE(NULLIF(m.from_name, ''), m.from_addr))",
  size: 'm.size',
};

function toMessage(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    folderId: row.folder_id,
    uid: row.uid,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.references_json),
    threadId: row.thread_id,
    subject: row.subject,
    from: row.from_addr ? { name: row.from_name, address: row.from_addr } : null,
    to: JSON.parse(row.to_json),
    cc: JSON.parse(row.cc_json),
    replyTo: JSON.parse(row.reply_to_json),
    dateSent: row.date_sent,
    dateReceived: row.date_received,
    size: row.size,
    hasAttachments: Boolean(row.has_attachments),
    flags: JSON.parse(row.flags_json),
    isRead: Boolean(row.is_read),
    isFlagged: Boolean(row.is_flagged),
    snippet: row.snippet,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    bodyFetchedAt: row.body_fetched_at,
  };
}

/** Sorted UIDs cached for a folder. */
export async function knownUids(db, folderId) {
  return (await db.all('SELECT uid FROM messages WHERE folder_id = ? ORDER BY uid', [folderId])).map((r) => r.uid);
}

/** Inserts envelopes from the server; existing UIDs only get their flags refreshed. Run inside a transaction. */
export async function saveEnvelopes(tx, folder, envelopes) {
  for (const e of envelopes) {
    const from = e.from[0] ?? null;
    await tx.run(
      `INSERT INTO messages (
        account_id, folder_id, uid, message_id, in_reply_to, references_json, subject, from_name, from_addr,
        to_json, cc_json, reply_to_json, date_sent, date_received, size, has_attachments,
        flags_json, is_read, is_flagged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (folder_id, uid) DO UPDATE SET
        flags_json = excluded.flags_json, is_read = excluded.is_read, is_flagged = excluded.is_flagged`,
      [
        folder.accountId,
        folder.id,
        e.uid,
        e.messageId,
        e.inReplyTo,
        JSON.stringify(e.references ?? []),
        e.subject,
        from?.name,
        from?.address?.toLowerCase(),
        JSON.stringify(e.to ?? []),
        JSON.stringify(e.cc ?? []),
        JSON.stringify(e.replyTo ?? []),
        e.dateSent,
        e.dateReceived ?? e.dateSent,
        e.size ?? 0,
        e.hasAttachments,
        JSON.stringify(e.flags),
        e.flags.includes('\\Seen'),
        e.flags.includes('\\Flagged'),
      ],
    );
  }
}

/** Run inside a transaction. */
export async function updateFlags(tx, folderId, messageFlags) {
  for (const { uid, flags } of messageFlags) {
    await tx.run(
      'UPDATE messages SET flags_json = ?, is_read = ?, is_flagged = ? WHERE folder_id = ? AND uid = ?',
      [JSON.stringify(flags), flags.includes('\\Seen'), flags.includes('\\Flagged'), folderId, uid],
    );
  }
}

/** Run inside a transaction. */
export async function deleteUids(tx, folderId, uids) {
  for (const uid of uids) {
    await tx.run('DELETE FROM messages WHERE folder_id = ? AND uid = ?', [folderId, uid]);
  }
}

export async function clearFolder(tx, folderId) {
  await tx.run('DELETE FROM messages WHERE folder_id = ?', [folderId]);
}

/**
 * Lists messages for one folder, or every account's inbox when `unified`.
 * `sort` is one of dateReceived, dateSent, sender, size.
 */
export async function listMessages(
  db,
  { folderId = null, unified = false, sort = 'dateReceived', descending = true, limit = 200, offset = 0 } = {},
) {
  const order = SORTS[sort] ?? SORTS.dateReceived;
  const direction = descending ? 'DESC' : 'ASC';
  const where = unified
    ? "m.folder_id IN (SELECT id FROM folders WHERE role = 'inbox')"
    : 'm.folder_id = ?';
  const rows = await db.all(
    `SELECT m.* FROM messages m WHERE ${where} ORDER BY ${order} ${direction}, m.id ${direction} LIMIT ? OFFSET ?`,
    unified ? [limit, offset] : [folderId, limit, offset],
  );
  return rows.map(toMessage);
}

export async function getMessage(db, id) {
  const row = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
  return row && toMessage(row);
}

export async function saveBody(db, id, { text, html, snippet }) {
  await db.run('UPDATE messages SET body_text = ?, body_html = ?, snippet = ?, body_fetched_at = ? WHERE id = ?', [
    text,
    html,
    snippet,
    Date.now(),
    id,
  ]);
}

export async function setLocalFlags(db, id, flags) {
  await db.run('UPDATE messages SET flags_json = ?, is_read = ?, is_flagged = ? WHERE id = ?', [
    JSON.stringify(flags),
    flags.includes('\\Seen'),
    flags.includes('\\Flagged'),
    id,
  ]);
}
