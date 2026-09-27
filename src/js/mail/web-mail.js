/**
 * In-memory stand-in for the DespatchMail native plugin, used in the browser
 * build and in tests. It behaves like a small IMAP server: UIDs, flags,
 * folders, moves and sends all work, and errors use the same codes as the
 * native plugin. The password "wrong" is always rejected.
 */
import { WebPlugin } from '@capacitor/core';

const HOUR = 3_600_000;

function mailError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sampleMessages(email, now) {
  const me = { name: 'Me', address: email };
  const bob = { name: 'Bob Smith', address: 'bob@example.org' };
  const zoe = { name: 'Zoë Ng', address: 'zoe@example.net' };
  const news = { name: 'Weekly Digest', address: 'digest@news.example.com' };

  const messages = [
    {
      subject: 'Project kickoff',
      from: [bob],
      to: [me],
      messageId: '<kickoff@example.org>',
      text: 'Hi, can we meet on Friday at 10am to plan the release?',
      hoursAgo: 72,
    },
    {
      subject: 'Re: Project kickoff',
      from: [zoe],
      to: [bob, me],
      messageId: '<kickoff-2@example.net>',
      inReplyTo: '<kickoff@example.org>',
      references: ['<kickoff@example.org>'],
      text: 'Friday works. The report is due by 15 October.',
      hoursAgo: 48,
    },
    {
      subject: 'Invoice #1042',
      from: [bob],
      to: [me],
      messageId: '<invoice-1042@example.org>',
      text: 'Please find the invoice attached. Payment is due within 30 days.',
      html: '<p>Please find the invoice attached.</p><p>Payment is due within <b>30 days</b>.</p>',
      attachments: [{ partId: '2', filename: 'invoice-1042.pdf', mimeType: 'application/pdf', size: 48_213 }],
      hoursAgo: 20,
      flags: ['\\Seen'],
    },
    {
      subject: 'This week in tech',
      from: [news],
      to: [me],
      messageId: '<digest-38@news.example.com>',
      html: '<h1>This week</h1><p>Top stories…</p><img src="cid:banner">',
      attachments: [
        { partId: '2', filename: null, mimeType: 'image/png', size: 9_120, contentId: 'banner', inline: true },
      ],
      hoursAgo: 5,
    },
    {
      subject: 'Re: Project kickoff',
      from: [bob],
      to: [zoe, me],
      messageId: '<kickoff-3@example.org>',
      inReplyTo: '<kickoff-2@example.net>',
      references: ['<kickoff@example.org>', '<kickoff-2@example.net>'],
      text: 'Great, see you both on Friday.',
      hoursAgo: 1,
      flags: ['\\Flagged'],
    },
  ];

  return messages.map((m, index) => ({
    uid: index + 1,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo ?? null,
    references: m.references ?? [],
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: [],
    replyTo: [],
    dateSent: now - m.hoursAgo * HOUR - 60_000,
    dateReceived: now - m.hoursAgo * HOUR,
    size: (m.text ?? m.html).length + (m.attachments ?? []).reduce((sum, a) => sum + a.size, 0) + 800,
    flags: m.flags ?? [],
    body: { text: m.text ?? null, html: m.html ?? null, attachments: m.attachments ?? [] },
  }));
}

function createMailbox(email, now) {
  const folder = (path, role, messages = []) => ({
    path,
    name: path,
    delimiter: '/',
    role,
    attributes: [],
    subscribed: true,
    selectable: true,
    uidValidity: 1,
    uidNext: messages.length + 1,
    messages,
  });
  return new Map(
    [
      folder('INBOX', 'inbox', sampleMessages(email, now)),
      folder('Sent', 'sent'),
      folder('Drafts', 'drafts'),
      folder('Archive', 'archive'),
      folder('Trash', 'trash'),
      folder('Junk', 'junk'),
    ].map((f) => [f.path, f]),
  );
}

function envelope({ body, ...rest }) {
  return {
    ...structuredClone(rest),
    hasAttachments: body.attachments.some((a) => !a.inline),
  };
}

export class DespatchMailWeb extends WebPlugin {
  constructor({ now = Date.now() } = {}) {
    super();
    this.now = now;
    this.credentials = new Map();
    this.mailboxes = new Map();
    this.sent = [];
  }

  // --- Credentials -------------------------------------------------------------------------

  async setCredentials({ accountId, password }) {
    this.credentials.set(accountId, password);
  }

  async deleteCredentials({ accountId }) {
    this.credentials.delete(accountId);
  }

  async hasCredentials({ accountId }) {
    return { value: this.credentials.has(accountId) };
  }

  async testConnection({ account, password }) {
    this.#checkPassword(password ?? this.credentials.get(account.id));
    return { capabilities: ['IDLE', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'], smtpChecked: Boolean(account.smtp) };
  }

  async disconnect() {}

  async getDynamicColors() {
    return { colors: [] };
  }

  // --- Folders and messages ------------------------------------------------------------------

  async listFolders({ account }) {
    const folders = [...this.#mailbox(account).values()].map(({ messages: _m, uidValidity: _v, uidNext: _n, ...info }) => info);
    return { folders };
  }

  async folderStatus({ account, path }) {
    const folder = this.#folder(account, path);
    return {
      path,
      uidValidity: folder.uidValidity,
      uidNext: folder.uidNext,
      highestModSeq: null,
      messages: folder.messages.length,
      unseen: folder.messages.filter((m) => !m.flags.includes('\\Seen')).length,
    };
  }

  async fetchEnvelopes({ account, path, query }) {
    return { messages: this.#select(this.#folder(account, path), query).map(envelope) };
  }

  async fetchFlags({ account, path, query }) {
    return { messages: this.#select(this.#folder(account, path), query).map(({ uid, flags }) => ({ uid, flags: [...flags] })) };
  }

  async fetchBody({ account, path, uid }) {
    const message = this.#message(this.#folder(account, path), uid);
    return { uid, ...structuredClone(message.body) };
  }

  async downloadAttachment({ account, path, uid, partId, filename }) {
    const attachment = this.#message(this.#folder(account, path), uid).body.attachments.find((a) => a.partId === partId);
    if (!attachment) throw mailError('MESSAGE_NOT_FOUND', `Attachment ${partId} not found.`);
    return { path: `memory://${account.id}/${path}/${uid}/${partId}/${filename ?? 'attachment'}`, size: attachment.size };
  }

  async setFlags({ account, path, uids, add = [], remove = [] }) {
    for (const message of this.#folder(account, path).messages) {
      if (!uids.includes(message.uid)) continue;
      message.flags = [...new Set([...message.flags, ...add])].filter((flag) => !remove.includes(flag));
    }
  }

  async moveMessages({ account, path, uids, destination }) {
    const source = this.#folder(account, path);
    const target = this.#folder(account, destination);
    const newUids = [];
    for (const uid of uids) {
      const index = source.messages.findIndex((m) => m.uid === uid);
      if (index === -1) continue;
      const [message] = source.messages.splice(index, 1);
      message.uid = target.uidNext++;
      target.messages.push(message);
      newUids.push(message.uid);
    }
    return { newUids };
  }

  // --- Sending -------------------------------------------------------------------------------

  async send({ account, message, sentFolder }) {
    this.#checkPassword(this.credentials.get(account.id));
    if (!account.smtp) throw mailError('INVALID_ARGUMENT', 'This account has no outgoing (SMTP) server.');
    if (![message.to, message.cc, message.bcc].some((list) => list?.length)) {
      throw mailError('INVALID_ARGUMENT', 'The message has no recipients.');
    }

    const domain = message.from.address.split('@')[1] ?? 'despatch.invalid';
    const messageId = `<${crypto.randomUUID()}@${domain}>`;
    this.sent.push({ ...structuredClone(message), messageId });

    const result = { messageId };
    if (sentFolder) {
      const folder = this.#folder(account, sentFolder);
      const uid = folder.uidNext++;
      folder.messages.push({
        uid,
        messageId,
        inReplyTo: message.inReplyTo ?? null,
        references: message.references ?? [],
        subject: message.subject,
        from: [message.from],
        to: message.to ?? [],
        cc: message.cc ?? [],
        replyTo: message.replyTo ?? [],
        dateSent: Date.now(),
        dateReceived: Date.now(),
        size: (message.text ?? message.html ?? '').length + 800,
        flags: ['\\Seen'],
        body: {
          text: message.text ?? null,
          html: message.html ?? null,
          attachments: (message.attachments ?? []).map((a, i) => ({
            partId: String(i + 2),
            filename: a.filename,
            mimeType: a.mimeType,
            size: 0,
            contentId: null,
            inline: false,
          })),
        },
      });
      result.sentFolderUid = uid;
    }
    return result;
  }

  // --- Helpers -------------------------------------------------------------------------------

  #checkPassword(password) {
    if (password === undefined) throw mailError('NO_CREDENTIALS', 'No password is stored for this account.');
    if (password === 'wrong') throw mailError('AUTH_FAILED', 'The username or password was not accepted.');
  }

  #mailbox(account) {
    this.#checkPassword(this.credentials.get(account.id));
    if (!this.mailboxes.has(account.id)) this.mailboxes.set(account.id, createMailbox(account.email, this.now));
    return this.mailboxes.get(account.id);
  }

  #folder(account, path) {
    const folder = this.#mailbox(account).get(path);
    if (!folder) throw mailError('FOLDER_NOT_FOUND', `Folder not found: ${path}`);
    return folder;
  }

  #message(folder, uid) {
    const message = folder.messages.find((m) => m.uid === uid);
    if (!message) throw mailError('MESSAGE_NOT_FOUND', `Message ${uid} not found.`);
    return message;
  }

  #select(folder, query) {
    const sorted = [...folder.messages].sort((a, b) => a.uid - b.uid);
    if ('uids' in query) return sorted.filter((m) => query.uids.includes(m.uid));
    if ('fromUid' in query) {
      const matches = sorted.filter((m) => m.uid >= query.fromUid && (query.toUid == null || m.uid <= query.toUid));
      // Like IMAP "n:*": when n is above the highest UID, "*" still matches the newest message.
      return matches.length === 0 && query.toUid == null ? sorted.slice(-1) : matches;
    }
    if ('latest' in query) return query.latest > 0 ? sorted.slice(-query.latest) : [];
    throw mailError('INVALID_ARGUMENT', 'query needs uids, fromUid or latest');
  }
}
