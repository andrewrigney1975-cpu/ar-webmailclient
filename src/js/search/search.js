/**
 * Local search over cached mail (PLAN.md §4.6). Text goes through the FTS4
 * index when the database has one (migration 5), otherwise LIKE. Structured
 * operators become ordinary WHERE clauses. Trash and Junk are left out unless
 * searched with in:trash / in:junk.
 */
import { getMessages } from '../db/repo-messages.js';

// Markers for highlighted words in snippets; escaped and turned into <mark> by the view.
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

let searchMode = null;

export async function searchModeOf(db) {
  if (searchMode) return searchMode;
  try {
    searchMode = (await db.get("SELECT value FROM app_meta WHERE key = 'search'"))?.value ?? 'like';
  } catch {
    searchMode = 'like';
  }
  return searchMode;
}

/** For tests: forget the cached mode. */
export function resetSearchMode() {
  searchMode = null;
}

/** FTS4 MATCH expression: every word must match; the last bare word matches as a prefix. */
export function ftsExpression(text) {
  const parts = text
    .map(({ value, phrase }, index) => {
      const clean = value.replace(/["*]/g, ' ').trim();
      if (!clean) return null;
      if (phrase) return `"${clean}"`;
      const words = clean.split(/[^\p{L}\p{N}@._-]+/u).filter(Boolean);
      return words
        .map((word, i) => {
          const last = index === text.length - 1 && i === words.length - 1;
          // FTS4 prefix syntax puts the star inside the quotes.
          return last ? `"${word}*"` : `"${word}"`;
        })
        .join(' ');
    })
    .filter(Boolean);
  return parts.join(' ');
}

function like(value) {
  return `%${value.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

function buildWhere(query, mode, folderRoles) {
  const where = [];
  const params = [];

  if (query.text.length && mode === 'fts4') {
    const expression = ftsExpression(query.text);
    if (expression) {
      where.push('m.id IN (SELECT docid FROM messages_fts WHERE messages_fts MATCH ?)');
      params.push(expression);
    }
  } else {
    for (const { value } of query.text) {
      where.push(
        "(LOWER(m.subject) LIKE ? ESCAPE '!' OR LOWER(m.from_name) LIKE ? ESCAPE '!' OR m.from_addr LIKE ? ESCAPE '!' OR LOWER(m.body_text) LIKE ? ESCAPE '!')",
      );
      const pattern = like(value.toLowerCase());
      params.push(pattern, pattern, pattern, pattern);
    }
  }

  for (const from of query.from) {
    where.push("(LOWER(m.from_name) LIKE ? ESCAPE '!' OR m.from_addr LIKE ? ESCAPE '!')");
    params.push(like(from), like(from));
  }
  for (const to of query.to) {
    where.push("LOWER(m.to_json || m.cc_json) LIKE ? ESCAPE '!'");
    params.push(like(to));
  }
  for (const subject of query.subject) {
    where.push("LOWER(m.subject) LIKE ? ESCAPE '!'");
    params.push(like(subject));
  }
  if (query.hasAttachment !== null) where.push(`m.has_attachments = ${query.hasAttachment ? 1 : 0}`);
  if (query.unread !== null) where.push(`m.is_read = ${query.unread ? 0 : 1}`);
  if (query.flagged !== null) where.push(`m.is_flagged = ${query.flagged ? 1 : 0}`);
  if (query.before !== null) {
    where.push('m.date_received < ?');
    params.push(query.before);
  }
  if (query.after !== null) {
    where.push('m.date_received >= ?');
    params.push(query.after);
  }
  if (query.larger !== null) {
    where.push('m.size > ?');
    params.push(query.larger);
  }
  if (query.smaller !== null) {
    where.push('m.size < ?');
    params.push(query.smaller);
  }

  if (query.folders.length) {
    const clauses = query.folders.map(() => "(f.role = ? OR LOWER(f.name) = ? OR LOWER(f.path) = ?)");
    where.push(`(${clauses.join(' OR ')})`);
    for (const folder of query.folders) params.push(folder, folder, folder);
  } else {
    where.push(`(f.role IS NULL OR f.role NOT IN (${folderRoles.hidden.map(() => '?').join(',')}))`);
    params.push(...folderRoles.hidden);
  }
  return { where: where.join(' AND ') || '1 = 1', params };
}

const SORTS = {
  dateReceived: 'm.date_received',
  dateSent: 'm.date_sent',
  sender: "LOWER(COALESCE(NULLIF(m.from_name, ''), m.from_addr))",
  size: 'm.size',
};

/**
 * Messages matching a parsed query, newest first by default. Each result has
 * `searchSnippet` (with MARK_START/MARK_END around matches) when FTS is used.
 */
export async function searchMessages(db, query, { sort = 'dateReceived', descending = true, limit = 50, offset = 0 } = {}) {
  const mode = await searchModeOf(db);
  const { where, params } = buildWhere(query, mode, { hidden: ['trash', 'junk'] });
  const order = SORTS[sort] ?? SORTS.dateReceived;
  const direction = descending ? 'DESC' : 'ASC';
  const rows = await db.all(
    `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE ${where} ORDER BY ${order} ${direction}, m.id ${direction} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const ids = rows.map((r) => r.id);
  const messages = await getMessages(db, ids);
  const byId = new Map(messages.map((m) => [m.id, m]));

  let snippets = new Map();
  const expression = mode === 'fts4' && query.text.length ? ftsExpression(query.text) : '';
  if (expression && ids.length) {
    const snippetRows = await db.all(
      `SELECT docid, snippet(messages_fts, ?, ?, '…', -1, 12) AS snippet FROM messages_fts
       WHERE messages_fts MATCH ? AND docid IN (${ids.map(() => '?').join(',')})`,
      [MARK_START, MARK_END, expression, ...ids],
    );
    snippets = new Map(snippetRows.map((r) => [r.docid, r.snippet]));
  }
  return ids.map((id) => ({ ...byId.get(id), searchSnippet: snippets.get(id) ?? null }));
}

export async function countSearch(db, query) {
  const mode = await searchModeOf(db);
  const { where, params } = buildWhere(query, mode, { hidden: ['trash', 'junk'] });
  return (await db.get(`SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${where}`, params)).n;
}

/** IMAP SEARCH criteria for the same query (text is matched server-side in subject, sender and body). */
export function serverCriteria(query) {
  return {
    text: query.text.map((t) => t.value),
    from: query.from,
    to: query.to,
    subject: query.subject,
    unread: query.unread,
    flagged: query.flagged,
    before: query.before,
    after: query.after,
    larger: query.larger,
    smaller: query.smaller,
  };
}
