/**
 * Pure compose logic (PLAN.md §4.3, §4.8): parsing address lists, building
 * replies and forwards with the right recipients, subject, threading
 * headers, quote and signature, and turning a draft into the outgoing
 * message the plugin sends.
 */
import { normaliseSubject } from '../mail/threading.js';
import { displayName, formatFullDate } from '../util/format.js';

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function isValidAddress(address) {
  return ADDRESS.test(address ?? '');
}

/** Parses "Name <a@b.c>, "Last, First" <d@e.f>; g@h.i" into [{ name, address }]. */
export function parseAddressList(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of text ?? '') {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') angle = true;
    if (!quoted && char === '>') angle = false;
    if (!quoted && !angle && (char === ',' || char === ';' || char === '\n')) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(.*?)<([^>]+)>\s*$/.exec(part);
      if (match) {
        const name = match[1].trim().replace(/^"(.*)"$/, '$1').trim();
        return { name: name || null, address: match[2].trim().toLowerCase() };
      }
      return { name: null, address: part.replace(/^mailto:/i, '').toLowerCase() };
    });
}

export function formatAddress(person) {
  if (!person.name) return person.address;
  return /[,;"<>]/.test(person.name) ? `"${person.name.replaceAll('"', '')}" <${person.address}>` : `${person.name} <${person.address}>`;
}

function uniqueAddresses(people, exclude = []) {
  const seen = new Set(exclude.map((a) => a.toLowerCase()));
  const out = [];
  for (const person of people) {
    const address = person.address?.toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ name: person.name ?? null, address });
  }
  return out;
}

function prefixed(prefix, subject) {
  const base = (subject ?? '').trim();
  const already = normaliseSubject(base) !== base.toLowerCase().replace(/\s+/g, ' ') && new RegExp(`^${prefix}:`, 'i').test(base);
  return already ? base : `${prefix}: ${base}`.trim();
}

function quote(text) {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n');
}

export function signatureBlock(signature) {
  return signature?.trim() ? `\n\n-- \n${signature.trim()}` : '';
}

/**
 * A new draft replying to or forwarding `message` (with its plain-text body).
 * @param {'reply' | 'replyall' | 'forward'} mode
 * @param {object} context  { account, myAddresses: string[] }
 */
export function buildResponse(mode, message, bodyText, { account, myAddresses }) {
  const mine = [account.email, ...myAddresses].map((a) => a.toLowerCase());
  const fromMe = mine.includes(message.from?.address?.toLowerCase());
  const date = formatFullDate(message.dateSent ?? message.dateReceived);
  const signature = signatureBlock(account.signature);
  const references = [...(message.references ?? []), message.messageId].filter(Boolean).slice(-20);

  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${message.from ? formatAddress(message.from) : ''}`,
      `Date: ${date}`,
      `Subject: ${message.subject ?? ''}`,
      `To: ${message.to.map(formatAddress).join(', ')}`,
      message.cc.length ? `Cc: ${message.cc.map(formatAddress).join(', ')}` : null,
    ].filter((line) => line !== null);
    return {
      accountId: account.id,
      to: [],
      cc: [],
      bcc: [],
      subject: prefixed('Fwd', message.subject),
      text: `${signature}\n\n${header.join('\n')}\n\n${bodyText ?? ''}`.replace(/^\n+/, '\n\n'),
      inReplyTo: null,
      references,
      forwardOf: message.id,
      replyOf: null,
      attachments: (message.attachments ?? [])
        .filter((a) => !a.inline)
        .map((a) => ({ filename: a.filename ?? 'attachment', mimeType: a.mimeType, size: a.size, fromMessage: { id: message.id, partId: a.partId } })),
    };
  }

  // Replying to my own message (e.g. from Sent) goes to its original recipients.
  const primary = fromMe ? message.to : message.replyTo.length ? message.replyTo : message.from ? [message.from] : [];
  let to = uniqueAddresses(primary, fromMe ? [] : mine);
  let cc = [];
  if (mode === 'replyall') {
    const others = fromMe ? message.cc : [...message.to, ...message.cc];
    cc = uniqueAddresses(others, [...mine, ...to.map((p) => p.address)]);
  }
  if (to.length === 0 && fromMe) to = uniqueAddresses(message.to);

  const attribution = `On ${date}, ${message.from ? displayName(message.from) : 'someone'} wrote:`;
  return {
    accountId: account.id,
    to,
    cc,
    bcc: [],
    subject: prefixed('Re', message.subject),
    text: `${signature}\n\n${attribution}\n${quote(bodyText ?? '')}`.replace(/^\n+/, '\n\n'),
    inReplyTo: message.messageId ?? null,
    references,
    forwardOf: null,
    replyOf: message.id,
    attachments: [],
  };
}

export function emptyDraft(account) {
  return {
    accountId: account.id,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    text: signatureBlock(account.signature) ? `\n\n${signatureBlock(account.signature).trimStart()}` : '',
    inReplyTo: null,
    references: [],
    forwardOf: null,
    replyOf: null,
    attachments: [],
  };
}

/** Draft fields from a mailto: URL (RFC 6068). */
export function draftFromMailto(url, account) {
  const draft = emptyDraft(account);
  const parsed = new URL(url);
  draft.to = parseAddressList(decodeURIComponent(parsed.pathname));
  const params = parsed.searchParams;
  if (params.get('cc')) draft.cc = parseAddressList(params.get('cc'));
  if (params.get('bcc')) draft.bcc = parseAddressList(params.get('bcc'));
  if (params.get('subject')) draft.subject = params.get('subject');
  if (params.get('body')) draft.text = `${params.get('body')}${draft.text}`;
  return draft;
}

/** True when a draft has nothing worth keeping. */
export function isBlankDraft(draft, account) {
  return (
    draft.to.length + draft.cc.length + draft.bcc.length === 0 &&
    !draft.subject.trim() &&
    draft.attachments.length === 0 &&
    draft.text.trim() === signatureBlock(account?.signature).trim()
  );
}

/** Problems that stop a draft being sent, or [] when it can go. */
export function validateDraft(draft) {
  const problems = [];
  const all = [...draft.to, ...draft.cc, ...draft.bcc];
  if (all.length === 0) problems.push('Add at least one recipient.');
  const invalid = all.filter((p) => !isValidAddress(p.address));
  if (invalid.length) problems.push(`Check ${invalid.map((p) => p.address).join(', ')}.`);
  return problems;
}

/** The message the plugin sends. `attachments` must already have local paths. */
export function toOutgoing(draft, account) {
  return {
    from: { name: account.displayName || null, address: account.email },
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    replyTo: [],
    subject: draft.subject,
    text: draft.text,
    html: null,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    attachments: draft.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, path: a.path })),
  };
}

/**
 * Autocomplete ranking: people you write to count three times as much as
 * people who write to you, and both fade over about six months.
 */
export function rankContacts(contacts, query, now = Date.now()) {
  const q = query.trim().toLowerCase();
  const score = (c) => {
    const ageDays = c.last_seen_at ? (now - c.last_seen_at) / 86_400_000 : 365;
    const base = c.times_sent_to * 3 + c.times_received_from + 1;
    const prefixBonus = c.address.startsWith(q) || (c.name ?? '').toLowerCase().startsWith(q) ? 2 : 1;
    return base * prefixBonus * Math.exp(-ageDays / 180);
  };
  return [...contacts].sort((a, b) => score(b) - score(a));
}
