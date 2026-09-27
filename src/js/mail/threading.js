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

// SQLite allows 999 bound parameters in older builds; stay well below.
const CHUNK = 400;

function chunks(values, size = CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

/**
 * Assigns thread IDs to messages that don't have one yet, oldest first.
 * Run inside a transaction. Returns the number of messages threaded.
 *
 * Everything the linking needs is loaded in a few batched queries and the
 * work is done in memory, because on Android each statement is a round trip
 * over the plugin bridge.
 */
export async function threadNewMessages(tx, accountId, { newId = () => crypto.randomUUID() } = {}) {
  const rows = (
    await tx.all(
      `SELECT id, message_id, in_reply_to, references_json, subject, date_sent, date_received
       FROM messages WHERE account_id = ? AND thread_id IS NULL
       ORDER BY COALESCE(date_sent, date_received), id`,
      [accountId],
    )
  ).map((row) => ({
    ...row,
    refs: referencesOf({ messageId: row.message_id, inReplyTo: row.in_reply_to, references: JSON.parse(row.references_json) }),
    subjectNorm: normaliseSubject(row.subject),
    date: row.date_sent ?? row.date_received ?? 0,
  }));
  if (rows.length === 0) return 0;

  // Threads already known for each Message-ID, and for each referenced ID.
  const byMessageId = new Map();
  const byRef = new Map();
  const ids = [...new Set(rows.flatMap((r) => (r.message_id ? [r.message_id, ...r.refs] : r.refs)))];
  for (const chunk of chunks(ids)) {
    for (const r of await tx.all(
      `SELECT message_id, thread_id FROM messages
       WHERE account_id = ? AND thread_id IS NOT NULL AND message_id IN (${placeholders(chunk)})`,
      [accountId, ...chunk],
    )) {
      addTo(byMessageId, r.message_id, r.thread_id);
    }
    for (const r of await tx.all(
      `SELECT DISTINCT r.ref, m.thread_id FROM message_refs r JOIN messages m ON m.id = r.message_row_id
       WHERE r.account_id = ? AND m.thread_id IS NOT NULL AND r.ref IN (${placeholders(chunk)})`,
      [accountId, ...chunk],
    )) {
      addTo(byRef, r.ref, r.thread_id);
    }
  }

  // Union-find over thread IDs, so merges made along the way stay consistent.
  const parent = new Map();
  const resolve = (thread) => {
    let root = thread;
    while (parent.has(root)) root = parent.get(root);
    return root;
  };
  const existingThreads = new Set([...byMessageId.values(), ...byRef.values()].flatMap((set) => [...set]));
  const assigned = new Map();
  const bySubject = new Map(); // this batch only; earlier messages are found with a query

  for (const row of rows) {
    const found = new Set();
    const collect = (set) => set?.forEach((t) => found.add(resolve(t)));
    // Parents and other copies of this message; replies that arrived first; siblings.
    for (const ref of row.refs) collect(byMessageId.get(ref));
    if (row.message_id) {
      collect(byMessageId.get(row.message_id));
      collect(byRef.get(row.message_id));
    }
    for (const ref of row.refs) collect(byRef.get(ref));

    if (found.size === 0 && row.refs.length === 0 && row.subjectNorm && isReplySubject(row.subject)) {
      const inBatch = (bySubject.get(row.subjectNorm) ?? []).findLast(
        (other) => Math.abs(other.date - row.date) <= SUBJECT_WINDOW_MS,
      );
      if (inBatch) {
        found.add(resolve(inBatch.thread));
      } else {
        const match = await tx.get(
          `SELECT thread_id FROM messages
           WHERE account_id = ? AND subject_norm = ? AND thread_id IS NOT NULL
             AND COALESCE(date_sent, date_received) BETWEEN ? AND ?
           ORDER BY COALESCE(date_sent, date_received) DESC LIMIT 1`,
          [accountId, row.subjectNorm, row.date - SUBJECT_WINDOW_MS, row.date + SUBJECT_WINDOW_MS],
        );
        if (match) {
          existingThreads.add(match.thread_id);
          found.add(resolve(match.thread_id));
        }
      }
    }

    const [threadId = newId(), ...others] = [...found];
    for (const other of others) parent.set(other, threadId);
    assigned.set(row.id, threadId);
    if (row.subjectNorm) {
      if (!bySubject.has(row.subjectNorm)) bySubject.set(row.subjectNorm, []);
      bySubject.get(row.subjectNorm).push({ date: row.date, thread: threadId });
    }

    if (row.message_id) addTo(byMessageId, row.message_id, threadId);
    for (const ref of row.refs) addTo(byRef, ref, threadId);
  }

  // Write: references, merged threads, then each message's thread.
  const refRows = rows.flatMap((row) => row.refs.map((ref) => [accountId, ref, row.id]));
  for (const chunk of chunks(refRows, Math.floor(CHUNK / 3))) {
    await tx.run(
      `INSERT INTO message_refs (account_id, ref, message_row_id) VALUES ${chunk.map(() => '(?, ?, ?)').join(',')}`,
      chunk.flat(),
    );
  }
  for (const thread of existingThreads) {
    const root = resolve(thread);
    if (root !== thread) {
      await tx.run('UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id = ?', [root, accountId, thread]);
    }
  }
  for (const chunk of chunks(rows, Math.floor(CHUNK / 5))) {
    const threadCases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
    const subjectCases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
    await tx.run(
      `UPDATE messages SET
         thread_id = CASE id ${threadCases} END,
         subject_norm = CASE id ${subjectCases} END
       WHERE id IN (${placeholders(chunk)})`,
      [
        ...chunk.flatMap((r) => [r.id, resolve(assigned.get(r.id))]),
        ...chunk.flatMap((r) => [r.id, r.subjectNorm]),
        ...chunk.map((r) => r.id),
      ],
    );
  }
  return rows.length;
}
