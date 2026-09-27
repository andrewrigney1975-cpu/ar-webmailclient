/**
 * Conversation queries (PLAN.md §4.2). A conversation appears in a folder
 * when any of its messages is there; its row shows the newest message in
 * that folder, with counts and participants from the whole conversation
 * (Trash and Junk excluded unless that is the folder being viewed).
 */
import { getMessage } from './repo-messages.js';

const SORTS = {
  dateReceived: 'm.date_received',
  dateSent: 'm.date_sent',
  sender: "LOWER(COALESCE(NULLIF(m.from_name, ''), m.from_addr))",
  size: 'm.size',
};

// Messages cached before threading ran have no thread ID yet; each is its own conversation.
const THREAD_KEY = "COALESCE(m.thread_id, 'm:' || m.id)";

function scope({ folderId = null, unified = false }) {
  return unified
    ? { where: "m.folder_id IN (SELECT id FROM folders WHERE role = 'inbox')", params: [] }
    : { where: 'm.folder_id = ?', params: [folderId] };
}

async function hiddenFolderIds(db, query) {
  if (!query.unified) {
    const viewing = await db.get('SELECT role FROM folders WHERE id = ?', [query.folderId]);
    if (viewing?.role === 'trash' || viewing?.role === 'junk') return [];
  }
  return (await db.all("SELECT id FROM folders WHERE role IN ('trash', 'junk')")).map((r) => r.id);
}

export async function countThreads(db, query) {
  const { where, params } = scope(query);
  return (await db.get(`SELECT COUNT(DISTINCT ${THREAD_KEY}) AS n FROM messages m WHERE ${where}`, params)).n;
}

/**
 * One row per conversation: the newest message in scope, plus
 * `thread = { key, count, unread, flagged, hasAttachments, participants }`.
 */
export async function listThreads(
  db,
  { folderId = null, unified = false, sort = 'dateReceived', descending = true, limit = 50, offset = 0 } = {},
) {
  const { where, params } = scope({ folderId, unified });
  const order = SORTS[sort] ?? SORTS.dateReceived;
  const direction = descending ? 'DESC' : 'ASC';
  const rows = await db.all(
    `SELECT m.id, m.account_id, m.folder_id, m.uid, m.thread_id, m.subject, m.from_name, m.from_addr, m.to_json,
            m.date_sent, m.date_received, m.size, m.snippet, m.thread_key
     FROM (
       SELECT m.*, ${THREAD_KEY} AS thread_key,
              ROW_NUMBER() OVER (PARTITION BY ${THREAD_KEY} ORDER BY m.date_received DESC, m.id DESC) AS rn
       FROM messages m WHERE ${where}
     ) m
     WHERE m.rn = 1
     ORDER BY ${order} ${direction}, m.id ${direction}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  if (rows.length === 0) return [];

  const hidden = await hiddenFolderIds(db, { folderId, unified });
  const keys = rows.map((r) => r.thread_key);
  const members = await db.all(
    `SELECT ${THREAD_KEY} AS thread_key, m.message_id, m.from_name, m.from_addr, m.is_read, m.is_flagged,
            m.has_attachments, m.folder_id
     FROM messages m
     WHERE ${THREAD_KEY} IN (${keys.map(() => '?').join(',')})
     ORDER BY COALESCE(m.date_sent, m.date_received), m.id`,
    keys,
  );

  const summaries = new Map(keys.map((key) => [key, { key, ids: new Set(), unread: false, flagged: false, hasAttachments: false, participants: [] }]));
  for (const member of members) {
    if (hidden.includes(member.folder_id)) continue;
    const summary = summaries.get(member.thread_key);
    summary.ids.add(member.message_id ?? `${member.thread_key}:${summary.ids.size}`);
    summary.unread ||= !member.is_read;
    summary.flagged ||= Boolean(member.is_flagged);
    summary.hasAttachments ||= Boolean(member.has_attachments);
    if (member.from_addr && !summary.participants.some((p) => p.address === member.from_addr)) {
      summary.participants.push({ name: member.from_name, address: member.from_addr });
    }
  }

  return rows.map((row) => {
    const { ids, ...summary } = summaries.get(row.thread_key);
    return {
      id: row.thread_key, // list identity
      threadKey: row.thread_key,
      messageId: row.id,
      accountId: row.account_id,
      folderId: row.folder_id,
      subject: row.subject,
      from: row.from_addr ? { name: row.from_name, address: row.from_addr } : null,
      to: JSON.parse(row.to_json),
      dateSent: row.date_sent,
      dateReceived: row.date_received,
      size: row.size,
      snippet: row.snippet,
      thread: { ...summary, count: Math.max(ids.size, 1) },
      isRead: !summary.unread,
      isFlagged: summary.flagged,
      hasAttachments: summary.hasAttachments,
    };
  });
}

/**
 * Messages of a conversation, oldest first, one per Message-ID (a copy
 * outside Trash/Junk is preferred, then one whose body is cached).
 */
export async function threadMessages(db, threadKey, { includeHidden = false } = {}) {
  if (threadKey.startsWith('m:')) {
    const message = await getMessage(db, Number(threadKey.slice(2)));
    return message ? [message] : [];
  }
  const rows = await db.all(
    `SELECT m.id, m.message_id, m.folder_id, m.body_fetched_at, f.role
     FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE m.thread_id = ?
     ORDER BY COALESCE(m.date_sent, m.date_received), m.id`,
    [threadKey],
  );
  const rank = (r) => (r.role === 'trash' || r.role === 'junk' ? 2 : 0) + (r.body_fetched_at ? 0 : 1);
  const chosen = new Map();
  for (const row of rows) {
    if (!includeHidden && (row.role === 'trash' || row.role === 'junk')) continue;
    const key = row.message_id ?? `row:${row.id}`;
    const current = chosen.get(key);
    if (!current || rank(row) < rank(current)) chosen.set(key, row);
  }
  const messages = [];
  for (const row of [...chosen.values()].sort((a, b) => rows.indexOf(a) - rows.indexOf(b))) {
    messages.push(await getMessage(db, row.id));
  }
  return messages;
}

/** IDs of the messages in scope (a folder or the unified inbox) that belong to these conversations. */
export async function messageIdsInThreads(db, threadKeys, query) {
  if (threadKeys.length === 0) return [];
  const { where, params } = scope(query);
  const rows = await db.all(
    `SELECT m.id FROM messages m WHERE ${where} AND ${THREAD_KEY} IN (${threadKeys.map(() => '?').join(',')})`,
    [...params, ...threadKeys],
  );
  return rows.map((r) => r.id);
}

/** IDs of every unread message in these conversations (outside Trash/Junk). */
export async function unreadIdsInThreads(db, threadKeys) {
  if (threadKeys.length === 0) return [];
  const rows = await db.all(
    `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE m.is_read = 0 AND f.role IS NOT 'trash' AND f.role IS NOT 'junk'
       AND ${THREAD_KEY} IN (${threadKeys.map(() => '?').join(',')})`,
    threadKeys,
  );
  return rows.map((r) => r.id);
}
