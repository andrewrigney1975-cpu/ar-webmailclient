/**
 * Search query language (PLAN.md §4.6):
 *
 *   words "exact phrase"      full-text match (last word matches as a prefix)
 *   from:bob  to:zoe  subject:invoice
 *   has:attachment  -has:attachment
 *   is:unread  is:read  is:flagged
 *   before:2026-10-01  after:2026-09-01  (also "today", "yesterday", "7d", "2w", "3m")
 *   larger:5M  smaller:200K
 *   in:inbox  in:sent  in:"Energy Accounts"
 *
 * A leading "-" negates has:/is:. Unknown operators are searched as text.
 */

const DAY = 86_400_000;

function parseDate(value, now) {
  const text = value.toLowerCase();
  const startOfToday = new Date(new Date(now).toDateString()).getTime();
  if (text === 'today') return startOfToday;
  if (text === 'yesterday') return startOfToday - DAY;
  const relative = /^(\d+)([dwmy])$/.exec(text);
  if (relative) {
    const days = { d: 1, w: 7, m: 30, y: 365 }[relative[2]] * Number(relative[1]);
    return startOfToday - days * DAY;
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
  return null;
}

function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(value);
  if (!match) return null;
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
  return Math.round(Number(match[1]) * unit);
}

/** Splits into tokens, keeping "quoted phrases" and op:"quoted values" together. */
function tokenize(text) {
  const tokens = [];
  const pattern = /(-?)([a-z]+:)?"([^"]*)"?|(\S+)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[4] !== undefined) tokens.push({ raw: match[4], quoted: false });
    else tokens.push({ raw: `${match[1]}${match[2] ?? ''}${match[3]}`, quoted: true, phraseOnly: !match[2] });
  }
  return tokens;
}

export function emptyQuery() {
  return {
    text: [], // [{ value, phrase }]
    from: [],
    to: [],
    subject: [],
    folders: [],
    hasAttachment: null, // true | false | null
    unread: null,
    flagged: null,
    before: null,
    after: null,
    larger: null,
    smaller: null,
  };
}

export function parseQuery(input, { now = Date.now() } = {}) {
  const query = emptyQuery();
  for (const token of tokenize(input ?? '')) {
    if (token.phraseOnly) {
      if (token.raw.trim()) query.text.push({ value: token.raw.trim(), phrase: true });
      continue;
    }
    const negated = token.raw.startsWith('-') && token.raw.length > 1;
    const body = negated ? token.raw.slice(1) : token.raw;
    const colon = body.indexOf(':');
    const op = colon > 0 ? body.slice(0, colon).toLowerCase() : null;
    const value = colon > 0 ? body.slice(colon + 1) : body;

    let handled = true;
    switch (op) {
      case 'from':
      case 'to':
      case 'subject':
        if (value) query[op].push(value.toLowerCase());
        else handled = false;
        break;
      case 'in':
        if (value) query.folders.push(value.toLowerCase());
        else handled = false;
        break;
      case 'has':
        if (/^attachments?$/i.test(value)) query.hasAttachment = !negated;
        else handled = false;
        break;
      case 'is':
        if (/^unread$/i.test(value)) query.unread = !negated;
        else if (/^read$/i.test(value)) query.unread = negated;
        else if (/^(flagged|starred)$/i.test(value)) query.flagged = !negated;
        else handled = false;
        break;
      case 'before':
      case 'after': {
        const date = parseDate(value, now);
        if (date == null) handled = false;
        else query[op] = date;
        break;
      }
      case 'larger':
      case 'smaller': {
        const size = parseSize(value);
        if (size == null) handled = false;
        else query[op] = size;
        break;
      }
      default:
        handled = false;
    }
    if (!handled && token.raw.trim()) query.text.push({ value: token.raw, phrase: token.quoted });
  }
  return query;
}

export function isEmptyQuery(query) {
  const blank = emptyQuery();
  return Object.keys(blank).every((key) => JSON.stringify(query[key]) === JSON.stringify(blank[key]));
}

/** Toggles an operator token (e.g. "is:unread") in the query text, for filter chips. */
export function toggleToken(input, token) {
  const words = (input ?? '').trim().split(/\s+/).filter(Boolean);
  const index = words.findIndex((w) => w.toLowerCase() === token.toLowerCase());
  if (index === -1) words.push(token);
  else words.splice(index, 1);
  return words.join(' ');
}

export function hasToken(input, token) {
  return (input ?? '')
    .trim()
    .split(/\s+/)
    .some((w) => w.toLowerCase() === token.toLowerCase());
}
