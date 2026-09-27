import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/js/db/database.js';
import { migrate, MIGRATIONS } from '../src/js/db/migrations.js';
import { sqlJsDriver } from '../src/js/db/driver-sqljs.js';
import { deleteAccount, insertAccount, listAccounts } from '../src/js/db/repo-accounts.js';
import { compareFolders, listFolders, replaceFolders } from '../src/js/db/repo-folders.js';
import { listMessages, saveEnvelopes } from '../src/js/db/repo-messages.js';
import { getContact, recordContacts } from '../src/js/db/repo-contacts.js';
import { testAccount, testDatabase } from './helpers.js';

const folder = (path, role = null) => ({
  path,
  name: path,
  delimiter: '/',
  role,
  attributes: [],
  subscribed: true,
  selectable: true,
});

const envelope = (uid, overrides = {}) => ({
  uid,
  messageId: `<${uid}@x>`,
  inReplyTo: null,
  references: [],
  subject: `Subject ${uid}`,
  from: [{ name: `Sender ${uid}`, address: `S${uid}@Example.org` }],
  to: [],
  cc: [],
  replyTo: [],
  dateSent: uid * 1000,
  dateReceived: uid * 1000 + 10,
  size: uid * 100,
  flags: [],
  hasAttachments: false,
  ...overrides,
});

describe('migrations', () => {
  it('apply once and record the schema version', async () => {
    const db = createDatabase(await sqlJsDriver());
    expect(await migrate(db)).toBe(MIGRATIONS.at(-1).version);
    expect(await migrate(db)).toBe(MIGRATIONS.at(-1).version);
    const rows = await db.all('SELECT version FROM schema_version');
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version })));
  });

  it('roll back a failing migration', async () => {
    const db = createDatabase(await sqlJsDriver());
    await expect(
      migrate(db, [{ version: 1, sql: 'CREATE TABLE ok (a); CREATE TABLE broken (' }]),
    ).rejects.toThrow();
    expect(await db.all("SELECT name FROM sqlite_master WHERE name = 'ok'")).toEqual([]);
  });
});

describe('database', () => {
  it('serialises transactions with other statements', async () => {
    const db = await testDatabase();
    await db.exec('CREATE TABLE log (n INTEGER)');
    const order = [];
    const tx = db.transaction(async (t) => {
      await t.run('INSERT INTO log VALUES (1)');
      await new Promise((r) => setTimeout(r, 20));
      await t.run('INSERT INTO log VALUES (2)');
      order.push('tx');
    });
    const outside = db.run('INSERT INTO log VALUES (3)').then(() => order.push('outside'));
    await Promise.all([tx, outside]);
    expect(order).toEqual(['tx', 'outside']);
    expect((await db.all('SELECT n FROM log')).map((r) => r.n)).toEqual([1, 2, 3]);
  });
});

describe('sql.js persistence', () => {
  it('keeps foreign keys on after saving a snapshot, and never saves mid-transaction', async () => {
    const snapshots = [];
    const driver = await sqlJsDriver({ persist: (bytes) => snapshots.push(bytes), persistDelayMs: 1 });
    const db = createDatabase(driver);
    await db.exec('PRAGMA foreign_keys = ON;');
    await migrate(db);
    await insertAccount(db, testAccount({ id: 'a' }));

    let release;
    const tx = db.transaction(async (t) => {
      await t.run("INSERT INTO folders (account_id, path, name) VALUES ('a', 'INBOX', 'INBOX')");
      await new Promise((resolve) => (release = resolve));
    });
    await new Promise((r) => setTimeout(r, 20));
    const beforeCommit = snapshots.length;
    release();
    await tx;
    driver.flush();

    expect(snapshots.length).toBeGreaterThan(beforeCommit);
    expect(await db.all('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    await deleteAccount(db, 'a');
    expect(await db.all('SELECT * FROM folders')).toEqual([]);
  });
});

describe('repositories', () => {
  it('round-trips accounts and cascades deletes', async () => {
    const db = await testDatabase();
    const a = testAccount();
    const b = testAccount({ smtp: null });
    await insertAccount(db, a);
    await insertAccount(db, b);

    const accounts = await listAccounts(db);
    expect(accounts.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(accounts[0]).toMatchObject({ email: a.email, imap: a.imap, smtp: a.smtp, accentColor: '#3867d6' });
    expect(accounts[1].smtp).toBeNull();

    await db.transaction((tx) => replaceFolders(tx, a.id, [folder('INBOX', 'inbox')]));
    const [inbox] = await listFolders(db, a.id);
    await db.transaction((tx) => saveEnvelopes(tx, inbox, [envelope(1)]));

    await deleteAccount(db, a.id);
    expect(await db.all('SELECT * FROM folders')).toEqual([]);
    expect(await db.all('SELECT * FROM messages')).toEqual([]);
  });

  it('replaces the folder list and orders role folders first', async () => {
    const db = await testDatabase();
    const a = testAccount();
    await insertAccount(db, a);

    await db.transaction((tx) =>
      replaceFolders(tx, a.id, [folder('Zeta'), folder('Sent', 'sent'), folder('INBOX', 'inbox'), folder('Old')]),
    );
    const [inbox] = await listFolders(db, a.id);
    await db.transaction((tx) => saveEnvelopes(tx, inbox, [envelope(1)]));

    await db.transaction((tx) =>
      replaceFolders(tx, a.id, [folder('INBOX', 'inbox'), folder('Sent', 'sent'), folder('Alpha'), folder('Zeta')]),
    );
    const folders = await listFolders(db, a.id);
    expect(folders.map((f) => f.path)).toEqual(['INBOX', 'Sent', 'Alpha', 'Zeta']);
    expect(folders[0].id).toBe(inbox.id);
    expect(await listMessages(db, { folderId: inbox.id })).toHaveLength(1);
    expect([{ role: 'trash', path: 'a' }, { role: 'inbox', path: 'b' }].sort(compareFolders)[0].role).toBe('inbox');
  });

  it('lists and sorts messages, and builds the unified inbox from every account', async () => {
    const db = await testDatabase();
    const [a, b] = [testAccount(), testAccount()];
    await insertAccount(db, a);
    await insertAccount(db, b);
    for (const account of [a, b]) {
      await db.transaction((tx) => replaceFolders(tx, account.id, [folder('INBOX', 'inbox'), folder('Archive')]));
    }
    const [inboxA, archiveA] = await listFolders(db, a.id);
    const [inboxB] = await listFolders(db, b.id);
    await db.transaction(async (tx) => {
      await saveEnvelopes(tx, inboxA, [envelope(1), envelope(3, { flags: ['\\Seen', '\\Flagged'] })]);
      await saveEnvelopes(tx, inboxB, [envelope(2, { dateSent: 99_999 })]);
      await saveEnvelopes(tx, archiveA, [envelope(4)]);
    });

    const unified = await listMessages(db, { unified: true });
    expect(unified.map((m) => m.uid)).toEqual([3, 2, 1]);
    expect(unified[0]).toMatchObject({ isRead: true, isFlagged: true, from: { address: 's3@example.org' } });

    const bySent = await listMessages(db, { unified: true, sort: 'dateSent' });
    expect(bySent.map((m) => m.uid)).toEqual([2, 3, 1]);
    const bySizeAsc = await listMessages(db, { unified: true, sort: 'size', descending: false });
    expect(bySizeAsc.map((m) => m.uid)).toEqual([1, 2, 3]);
    const bySender = await listMessages(db, { unified: true, sort: 'sender', descending: false });
    expect(bySender.map((m) => m.uid)).toEqual([1, 2, 3]);

    expect((await listMessages(db, { folderId: archiveA.id })).map((m) => m.uid)).toEqual([4]);
  });

  it('counts contacts by direction and keeps the best name', async () => {
    const db = await testDatabase();
    await db.transaction(async (tx) => {
      await recordContacts(tx, [{ name: 'Bob', address: 'Bob@Example.org' }], 'received', 100);
      await recordContacts(tx, [{ name: null, address: 'bob@example.org' }], 'sent', 50);
      await recordContacts(tx, [{ name: 'Bob', address: 'bob@example.org' }], 'sent', 200);
    });
    expect(await getContact(db, 'BOB@example.org')).toEqual({
      address: 'bob@example.org',
      name: 'Bob',
      times_sent_to: 2,
      times_received_from: 1,
      last_seen_at: 200,
    });
  });
});
