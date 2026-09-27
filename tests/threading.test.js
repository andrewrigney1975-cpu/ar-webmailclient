import { describe, expect, it } from 'vitest';
import { insertAccount } from '../src/js/db/repo-accounts.js';
import { listFolders, replaceFolders } from '../src/js/db/repo-folders.js';
import { saveEnvelopes } from '../src/js/db/repo-messages.js';
import { isReplySubject, normaliseSubject, referencesOf, threadNewMessages } from '../src/js/mail/threading.js';
import { testAccount, testDatabase } from './helpers.js';

const DAY = 86_400_000;
let uid = 0;

function envelope({ id, inReplyTo = null, references = [], subject = 'Plans', date = 0 }) {
  uid += 1;
  return {
    uid,
    messageId: id,
    inReplyTo,
    references,
    subject,
    from: [{ name: 'X', address: 'x@example.org' }],
    to: [],
    cc: [],
    replyTo: [],
    dateSent: date,
    dateReceived: date,
    size: 100,
    flags: [],
    hasAttachments: false,
  };
}

async function fixture() {
  const db = await testDatabase();
  const account = testAccount();
  await insertAccount(db, account);
  await db.transaction((tx) =>
    replaceFolders(tx, account.id, [
      { path: 'INBOX', name: 'INBOX', role: 'inbox', attributes: [], subscribed: true, selectable: true },
      { path: 'Sent', name: 'Sent', role: 'sent', attributes: [], subscribed: true, selectable: true },
    ]),
  );
  const [inbox, sent] = await listFolders(db, account.id);
  let n = 0;

  async function arrive(folder, ...envelopes) {
    await db.transaction(async (tx) => {
      await saveEnvelopes(tx, folder, envelopes);
      await threadNewMessages(tx, account.id, { newId: () => `t${++n}` });
    });
  }

  async function threadOf(messageId) {
    const rows = await db.all('SELECT DISTINCT thread_id FROM messages WHERE message_id = ?', [messageId]);
    expect(rows).toHaveLength(1);
    return rows[0].thread_id;
  }

  return { db, account, inbox, sent, arrive, threadOf };
}

describe('subjects', () => {
  it('strips reply and forward prefixes in several languages, and list tags', () => {
    expect(normaliseSubject('Re: RE: Fwd: Plans')).toBe('plans');
    expect(normaliseSubject('AW: WG: Termin')).toBe('termin');
    expect(normaliseSubject('SV: Möte')).toBe('möte');
    expect(normaliseSubject('[dev-list] Re: [dev-list] Build   broken')).toBe('build broken');
    expect(normaliseSubject('Re[2]: Quote')).toBe('quote');
    expect(normaliseSubject('Report on revenue')).toBe('report on revenue');
  });

  it('recognises replies', () => {
    expect(isReplySubject('Re: x')).toBe(true);
    expect(isReplySubject('[list] Fwd: x')).toBe(true);
    expect(isReplySubject('Reply needed')).toBe(false);
  });

  it('collects references and In-Reply-To without duplicates or self-references', () => {
    expect(referencesOf({ messageId: '<c>', references: ['<a>', '<b>'], inReplyTo: '<b>' })).toEqual(['<a>', '<b>']);
    expect(referencesOf({ messageId: '<c>', references: ['<c>'], inReplyTo: null })).toEqual([]);
  });
});

describe('threadNewMessages', () => {
  it('links a reply to its parent', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<a>' }), envelope({ id: '<b>', inReplyTo: '<a>', references: ['<a>'], date: 1 }));
    expect(await fx.threadOf('<b>')).toBe(await fx.threadOf('<a>'));
  });

  it('links a parent that arrives after its reply', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<b>', references: ['<a>'], date: 5 }));
    await fx.arrive(fx.inbox, envelope({ id: '<a>', date: 1 }));
    expect(await fx.threadOf('<a>')).toBe(await fx.threadOf('<b>'));
  });

  it('links siblings whose shared root was never seen', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<b>', references: ['<root>'] }));
    await fx.arrive(fx.inbox, envelope({ id: '<c>', references: ['<root>'], inReplyTo: '<root>' }));
    expect(await fx.threadOf('<b>')).toBe(await fx.threadOf('<c>'));
  });

  it('merges two threads when a message connects them', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<a>', subject: 'One' }));
    await fx.arrive(fx.inbox, envelope({ id: '<x>', subject: 'Two' }));
    expect(await fx.threadOf('<a>')).not.toBe(await fx.threadOf('<x>'));

    await fx.arrive(fx.inbox, envelope({ id: '<m>', references: ['<a>', '<x>'] }));
    const thread = await fx.threadOf('<m>');
    expect(await fx.threadOf('<a>')).toBe(thread);
    expect(await fx.threadOf('<x>')).toBe(thread);
  });

  it('threads my replies from Sent with the inbox messages', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<a>' }));
    await fx.arrive(fx.sent, envelope({ id: '<mine>', inReplyTo: '<a>', references: ['<a>'], subject: 'Re: Plans' }));
    expect(await fx.threadOf('<mine>')).toBe(await fx.threadOf('<a>'));
  });

  it('gives copies of one message in two folders the same thread', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<dup>' }));
    await fx.arrive(fx.sent, envelope({ id: '<dup>' }));
    await fx.threadOf('<dup>'); // asserts a single distinct thread
  });

  it('falls back to the subject for replies without reference headers', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<a>', subject: 'Budget 2027', date: 0 }));
    await fx.arrive(fx.inbox, envelope({ id: '<b>', subject: 'RE: Budget 2027', date: 2 * DAY }));
    expect(await fx.threadOf('<b>')).toBe(await fx.threadOf('<a>'));
  });

  it('does not use the subject for non-replies, or across long gaps', async () => {
    const fx = await fixture();
    await fx.arrive(fx.inbox, envelope({ id: '<a>', subject: 'Weekly report', date: 0 }));
    await fx.arrive(fx.inbox, envelope({ id: '<b>', subject: 'Weekly report', date: DAY }));
    await fx.arrive(fx.inbox, envelope({ id: '<c>', subject: 'Re: Weekly report', date: 90 * DAY }));
    const threads = new Set([await fx.threadOf('<a>'), await fx.threadOf('<b>'), await fx.threadOf('<c>')]);
    expect(threads.size).toBe(3);
  });

  it('keeps accounts apart', async () => {
    const fx = await fixture();
    const other = testAccount();
    await insertAccount(fx.db, other);
    await fx.db.transaction((tx) =>
      replaceFolders(tx, other.id, [{ path: 'INBOX', name: 'INBOX', role: 'inbox', attributes: [], subscribed: true, selectable: true }]),
    );
    const [otherInbox] = await listFolders(fx.db, other.id);
    await fx.arrive(fx.inbox, envelope({ id: '<a>' }));
    await fx.db.transaction(async (tx) => {
      await saveEnvelopes(tx, otherInbox, [envelope({ id: '<b>', references: ['<a>'] })]);
      await threadNewMessages(tx, other.id, { newId: () => 'other' });
    });
    expect(await fx.threadOf('<b>')).toBe('other');
  });

  it('uses a handful of statements for a large batch', async () => {
    const fx = await fixture();
    const batch = Array.from({ length: 200 }, (_, i) =>
      envelope({ id: `<p${i}>`, references: i ? [`<p${Math.floor(i / 2)}>`] : [], date: i }),
    );
    await fx.db.transaction((tx) => saveEnvelopes(tx, fx.inbox, batch));

    let statements = 0;
    await fx.db.transaction(async (tx) => {
      const counted = {
        all: (...args) => (statements++, tx.all(...args)),
        get: (...args) => (statements++, tx.get(...args)),
        run: (...args) => (statements++, tx.run(...args)),
      };
      await threadNewMessages(counted, fx.account.id);
    });

    expect(statements).toBeLessThan(20);
    expect(await fx.db.all('SELECT DISTINCT thread_id FROM messages')).toHaveLength(1);
  });

  it('threads a whole mailbox in one pass', async () => {
    const fx = await fixture();
    const chain = Array.from({ length: 50 }, (_, i) =>
      envelope({
        id: `<m${i}>`,
        references: Array.from({ length: i }, (_, j) => `<m${j}>`).slice(-10),
        date: i,
      }),
    );
    await fx.arrive(fx.inbox, ...chain.reverse());
    const threads = await fx.db.all('SELECT DISTINCT thread_id FROM messages');
    expect(threads).toHaveLength(1);
  });
});
