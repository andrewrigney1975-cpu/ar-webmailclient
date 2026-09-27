/**
 * Conversation threading (PLAN.md §4.2), JWZ-style: messages that are linked
 * through Message-ID / In-Reply-To / References, directly or through a
 * shared ancestor we never saw, belong to one thread. This runs
 * incrementally as messages arrive, in any order:
 *
 *   - a reply finds its parent (the parent's Message-ID is in its refs)
 *   - a parent finds replies that arrived first (they reference its ID)
 *   - siblings whose common root is missing find each other (shared ref)
 *   - copies of one message in several folders share its Message-ID
 *
 * Joining two existing threads merges them. As in JWZ, messages with a
 * reply prefix but no reference headers fall back to matching the subject,
 * limited to recent messages so unrelated "Re: Hello"s don't pile up.
 */

const REPLY_PREFIX = /^\s*((re|fwd?|aw|wg|sv|vs|antw|doorst|rif|r|tr|odp|ynt)(\[\d+\])?\s*:\s*)+/i;
const LIST_TAG = /^\s*\[[^\]]{1,40}\]\s*/;
const SUBJECT_WINDOW_MS = 30 * 86_400_000;

/** Subject without reply/forward prefixes (in several languages) or a leading [list] tag. */
export function normaliseSubject(subject) {
  let text = (subject ?? '').trim();
  for (let i = 0; i < 5; i++) {
    const next = text.replace(LIST_TAG, '').replace(REPLY_PREFIX, '').trim();
    if (next === text) break;
    text = next;
  }
  return text.toLowerCase().replace(/\s+/g, ' ');
}

export function isReplySubject(subject) {
  return REPLY_PREFIX.test((subject ?? '').replace(LIST_TAG, ''));
}

/** Message-IDs this message points at, most distant ancestor first. */
export function referencesOf(message) {
  const refs = [...(message.references ?? [])];
  if (message.inReplyTo && !refs.includes(message.inReplyTo)) refs.push(message.inReplyTo);
  return refs.filter((ref) => ref && ref !== message.messageId);
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

async function relatedThreads(tx, accountId, row, refs) {
  const found = new Set();
  const add = (rows) => rows.forEach((r) => r.thread_id && found.add(r.thread_id));

  // Parents, and other copies of this same message.
  const ids = row.message_id ? [...refs, row.message_id] : refs;
  if (ids.length) {
    add(
      await tx.all(
        `SELECT DISTINCT thread_id FROM messages
         WHERE account_id = ? AND message_id IN (${placeholders(ids)}) AND id != ? AND thread_id IS NOT NULL`,
        [accountId, ...ids, row.id],
      ),
    );
  }
  // Replies that arrived first, and siblings sharing an ancestor.
  const refTargets = row.message_id ? [row.message_id, ...refs] : refs;
  if (refTargets.length) {
    add(
      await tx.all(
        `SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.id = r.message_row_id
         WHERE r.account_id = ? AND r.ref IN (${placeholders(refTargets)}) AND m.id != ? AND m.thread_id IS NOT NULL`,
        [accountId, ...refTargets, row.id],
      ),
    );
  }
  return [...found];
}

/**
 * Assigns thread IDs to messages that don't have one yet, oldest first.
 * Run inside a transaction. Returns the number of messages threaded.
 */
export async function threadNewMessages(tx, accountId, { newId = () => crypto.randomUUID() } = {}) {
  const rows = await tx.all(
    `SELECT id, message_id, in_reply_to, references_json, subject, date_sent, date_received
     FROM messages WHERE account_id = ? AND thread_id IS NULL
     ORDER BY COALESCE(date_sent, date_received), id`,
    [accountId],
  );

  for (const row of rows) {
    const refs = referencesOf({
      messageId: row.message_id,
      inReplyTo: row.in_reply_to,
      references: JSON.parse(row.references_json),
    });
    const subjectNorm = normaliseSubject(row.subject);

    for (const ref of refs) {
      await tx.run('INSERT INTO message_refs (account_id, ref, message_row_id) VALUES (?, ?, ?)', [
        accountId,
        ref,
        row.id,
      ]);
    }

    let threads = await relatedThreads(tx, accountId, row, refs);

    if (threads.length === 0 && refs.length === 0 && subjectNorm && isReplySubject(row.subject)) {
      const date = row.date_sent ?? row.date_received ?? 0;
      const match = await tx.get(
        `SELECT thread_id FROM messages
         WHERE account_id = ? AND subject_norm = ? AND thread_id IS NOT NULL AND id != ?
           AND COALESCE(date_sent, date_received) BETWEEN ? AND ?
         ORDER BY COALESCE(date_sent, date_received) DESC LIMIT 1`,
        [accountId, subjectNorm, row.id, date - SUBJECT_WINDOW_MS, date + SUBJECT_WINDOW_MS],
      );
      if (match) threads = [match.thread_id];
    }

    const threadId = threads[0] ?? newId();
    if (threads.length > 1) {
      await tx.run(
        `UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id IN (${placeholders(threads.slice(1))})`,
        [threadId, accountId, ...threads.slice(1)],
      );
    }
    await tx.run('UPDATE messages SET thread_id = ?, subject_norm = ? WHERE id = ?', [threadId, subjectNorm, row.id]);
  }
  return rows.length;
}
