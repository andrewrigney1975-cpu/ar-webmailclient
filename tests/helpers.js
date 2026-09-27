import { openDatabase } from '../src/js/db/database.js';
import { sqlJsDriver } from '../src/js/db/driver-sqljs.js';
import { insertAccount } from '../src/js/db/repo-accounts.js';
import { createMailApi } from '../src/js/mail/bridge.js';
import { DespatchMailWeb } from '../src/js/mail/web-mail.js';

export async function testDatabase() {
  return openDatabase({ driver: await sqlJsDriver() });
}

let counter = 0;

export function testAccount(overrides = {}) {
  counter += 1;
  return {
    id: `acc-${counter}`,
    email: `user${counter}@example.com`,
    displayName: `User ${counter}`,
    imap: { host: 'imap.example.com', port: 993, security: 'tls', username: `user${counter}` },
    smtp: { host: 'smtp.example.com', port: 465, security: 'tls', username: `user${counter}` },
    accentColor: '#3867d6',
    signature: null,
    ...overrides,
  };
}

/** A database with one account, and an in-memory mail server holding that account's sample mailbox. */
export async function syncFixture() {
  const db = await testDatabase();
  const plugin = new DespatchMailWeb({ now: Date.UTC(2026, 8, 27, 12) });
  const mail = createMailApi(plugin);
  const account = testAccount();
  await insertAccount(db, account);
  await mail.setCredentials(account.id, 'secret');
  return { db, plugin, mail, account };
}

/** Adds a message to a folder on the in-memory server, as if it had just arrived. */
export function deliver(plugin, account, path, overrides = {}) {
  const folder = plugin.mailboxes.get(account.id).get(path);
  const uid = folder.uidNext++;
  folder.messages.push({
    uid,
    messageId: `<new-${uid}@example.org>`,
    inReplyTo: null,
    references: [],
    subject: `New ${uid}`,
    from: [{ name: 'Nia', address: 'nia@example.org' }],
    to: [{ name: null, address: account.email }],
    cc: [],
    replyTo: [],
    dateSent: Date.UTC(2026, 8, 27, 13),
    dateReceived: Date.UTC(2026, 8, 27, 13),
    size: 1000,
    flags: [],
    body: { text: 'Hello', html: null, attachments: [] },
    ...overrides,
  });
  return uid;
}
