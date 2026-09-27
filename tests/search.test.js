import { beforeEach, describe, expect, it } from 'vitest';
import { hasToken, isEmptyQuery, parseQuery, toggleToken } from '../src/js/search/query-parser.js';
import { countSearch, ftsExpression, MARK_END, MARK_START, resetSearchMode, searchMessages } from '../src/js/search/search.js';
import { insertAccount } from '../src/js/db/repo-accounts.js';
import { listFolders, replaceFolders } from '../src/js/db/repo-folders.js';
import { saveBody, saveEnvelopes } from '../src/js/db/repo-messages.js';
import { testAccount, testDatabase } from './helpers.js';

const NOW = new Date(2026, 9, 10, 12).getTime();
const DAY = 86_400_000;

describe('parseQuery', () => {
  it('separates text, phrases and operators', () => {
    const q = parseQuery('invoice "due by friday" from:bob to:zoe subject:Q3 has:attachment is:unread larger:5M before:2026-10-01', { now: NOW });
    expect(q.text).toEqual([
      { value: 'invoice', phrase: false },
      { value: 'due by friday', phrase: true },
    ]);
    expect(q).toMatchObject({
      from: ['bob'],
      to: ['zoe'],
      subject: ['q3'],
      hasAttachment: true,
      unread: true,
      larger: 5 * 1024 * 1024,
      before: new Date(2026, 9, 1).getTime(),
    });
  });

  it('handles negation, relative dates, quoted operator values and unknown operators', () => {
    const q = parseQuery('-has:attachment -is:unread is:starred after:7d in:"Energy Accounts" foo:bar smaller:200k', { now: NOW });
    expect(q).toMatchObject({ hasAttachment: false, unread: false, flagged: true, folders: ['energy accounts'], smaller: 200 * 1024 });
    expect(q.after).toBe(new Date(2026, 9, 10).getTime() - 7 * DAY);
    expect(q.text).toEqual([{ value: 'foo:bar', phrase: false }]);
  });

  it('toggles filter tokens for chips', () => {
    expect(toggleToken('invoice', 'is:unread')).toBe('invoice is:unread');
    expect(toggleToken('invoice is:unread', 'is:unread')).toBe('invoice');
    expect(hasToken('a IS:UNREAD', 'is:unread')).toBe(true);
    expect(isEmptyQuery(parseQuery('   '))).toBe(true);
  });
});

describe('ftsExpression', () => {
  it('quotes words, keeps phrases and makes the last word a prefix', () => {
    expect(ftsExpression([{ value: 'inv', phrase: false }])).toBe('"inv*"');
    expect(ftsExpression([{ value: 'due by', phrase: true }, { value: 'fri', phrase: false }])).toBe('"due by" "fri*"');
    expect(ftsExpression([{ value: 'a"b OR c*', phrase: false }])).toBe('"a" "b" "OR" "c*"');
  });
});

async function fixture() {
  resetSearchMode();
  const db = await testDatabase();
  const account = testAccount();
  await insertAccount(db, account);
  const folder = (path, role) => ({ path, name: path, role, attributes: [], subscribed: true, selectable: true });
  await db.transaction((tx) =>
    replaceFolders(tx, account.id, [folder('INBOX', 'inbox'), folder('Trash', 'trash'), folder('Energy Accounts', null)]),
  );
  const folders = Object.fromEntries((await listFolders(db, account.id)).map((f) => [f.path, f]));
  let uid = 0;
  const add = async (path, { subject, from = 'bob@example.org', name = 'Bob', body = null, flags = [], size = 1000, attach = false, date = NOW }) => {
    uid += 1;
    await db.transaction((tx) =>
      saveEnvelopes(tx, folders[path], [
        {
          uid,
          messageId: `<${uid}@x>`,
          inReplyTo: null,
          references: [],
          subject,
          from: [{ name, address: from }],
          to: [{ name: 'Zoë', address: 'zoe@example.net' }],
          cc: [],
          replyTo: [],
          dateSent: date,
          dateReceived: date,
          size,
          flags,
          hasAttachments: attach,
        },
      ]),
    );
    const { id } = await db.get('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', [folders[path].id, uid]);
    if (body) await saveBody(db, id, { text: body, html: null, snippet: body.slice(0, 20) });
    return id;
  };

  const invoice = await add('INBOX', { subject: 'Invoice #1042', body: 'Payment is due by Friday, merci', attach: true, size: 6_000_000 });
  const cafe = await add('INBOX', { subject: 'Café catch-up', from: 'zoe@example.net', name: 'Zoë Ng', flags: ['\\Seen'], date: NOW - 10 * DAY });
  const energy = await add('Energy Accounts', { subject: 'Your electricity bill', from: 'billing@power.example', name: 'Power Co', body: 'Invoice attached', flags: ['\\Seen', '\\Flagged'], date: NOW - DAY });
  const trashed = await add('Trash', { subject: 'Old invoice', flags: ['\\Seen'] });
  return { db, ids: { invoice, cafe, energy, trashed } };
}

const ids = (results) => results.map((m) => m.id);

describe('searchMessages', () => {
  let fx;
  beforeEach(async () => {
    fx = await fixture();
  });

  it('finds words in subject and body, by prefix, ignoring accents, and skips Trash', async () => {
    expect(ids(await searchMessages(fx.db, parseQuery('invoice')))).toEqual([fx.ids.invoice, fx.ids.energy]);
    expect(ids(await searchMessages(fx.db, parseQuery('invo')))).toEqual([fx.ids.invoice, fx.ids.energy]);
    expect(ids(await searchMessages(fx.db, parseQuery('cafe')))).toEqual([fx.ids.cafe]);
    expect(ids(await searchMessages(fx.db, parseQuery('invoice in:trash')))).toEqual([fx.ids.trashed]);
    expect(await countSearch(fx.db, parseQuery('invoice'))).toBe(2);
  });

  it('matches phrases and highlights them in a snippet', async () => {
    const [hit] = await searchMessages(fx.db, parseQuery('"due by friday"'));
    expect(hit.id).toBe(fx.ids.invoice);
    expect(hit.searchSnippet).toContain(`${MARK_START}due${MARK_END}`);
    expect(await searchMessages(fx.db, parseQuery('"friday by due"'))).toEqual([]);
  });

  it('applies operators', async () => {
    expect(ids(await searchMessages(fx.db, parseQuery('from:zoë')))).toEqual([fx.ids.cafe]);
    expect(ids(await searchMessages(fx.db, parseQuery('to:zoe subject:bill')))).toEqual([fx.ids.energy]);
    expect(ids(await searchMessages(fx.db, parseQuery('has:attachment')))).toEqual([fx.ids.invoice]);
    expect(ids(await searchMessages(fx.db, parseQuery('is:unread')))).toEqual([fx.ids.invoice]);
    expect(ids(await searchMessages(fx.db, parseQuery('is:flagged')))).toEqual([fx.ids.energy]);
    expect(ids(await searchMessages(fx.db, parseQuery('larger:5M')))).toEqual([fx.ids.invoice]);
    expect(ids(await searchMessages(fx.db, parseQuery('before:3d', { now: NOW })))).toEqual([fx.ids.cafe]);
    expect(ids(await searchMessages(fx.db, parseQuery('in:"energy accounts"')))).toEqual([fx.ids.energy]);
  });

  it('sorts results', async () => {
    const bySender = await searchMessages(fx.db, parseQuery('is:read'), { sort: 'sender', descending: false });
    expect(bySender.map((m) => m.from.name)).toEqual(['Power Co', 'Zoë Ng']);
  });

  it('keeps the index current as messages change', async () => {
    await fx.db.run("UPDATE messages SET subject = 'Renamed thing' WHERE id = ?", [fx.ids.cafe]);
    expect(ids(await searchMessages(fx.db, parseQuery('renamed')))).toEqual([fx.ids.cafe]);
    expect(await searchMessages(fx.db, parseQuery('cafe'))).toEqual([]);
    await fx.db.run('DELETE FROM messages WHERE id = ?', [fx.ids.invoice]);
    expect(ids(await searchMessages(fx.db, parseQuery('invoice')))).toEqual([fx.ids.energy]);
  });

  it('falls back to LIKE without the full-text index', async () => {
    await fx.db.run("UPDATE app_meta SET value = 'like' WHERE key = 'search'");
    resetSearchMode();
    expect(ids(await searchMessages(fx.db, parseQuery('invoice')))).toEqual([fx.ids.invoice, fx.ids.energy]);
    expect((await searchMessages(fx.db, parseQuery('invoice')))[0].searchSnippet).toBeNull();
  });
});

describe('server search', () => {
  it('fetches and caches matches that are not stored locally', async () => {
    const { syncFixture, deliver } = await import('./helpers.js');
    const { syncFolderList, syncFolder } = await import('../src/js/mail/sync.js');
    const { searchServer } = await import('../src/js/search/server-search.js');
    const { createStore } = await import('../src/js/store.js');
    resetSearchMode();
    const fx = await syncFixture();
    await syncFolderList(fx);
    const inbox = (await listFolders(fx.db, fx.account.id)).find((f) => f.role === 'inbox');
    await syncFolder({ ...fx, folder: inbox });
    // An old message the phone never synced (arrived before the cached range).
    deliver(fx.plugin, fx.account, 'Archive', { subject: 'Warranty certificate 2019' });
    const store = createStore({ accounts: [fx.account], folders: await listFolders(fx.db) });

    expect(await searchMessages(fx.db, parseQuery('warranty'))).toEqual([]);
    const found = await searchServer({ db: fx.db, mail: fx.mail, store, query: parseQuery('warranty') });
    expect(found).toBe(1);
    expect((await searchMessages(fx.db, parseQuery('warranty'))).map((m) => m.subject)).toEqual(['Warranty certificate 2019']);
    expect(await searchServer({ db: fx.db, mail: fx.mail, store, query: parseQuery('warranty') })).toBe(0);
  });
});

describe('attachment filter', () => {
  it('limits lists and conversations to messages with or without attachments', async () => {
    const { listMessages, countMessages } = await import('../src/js/db/repo-messages.js');
    const { countThreads } = await import('../src/js/db/repo-threads.js');
    const fx = await fixture();
    const inbox = (await fx.db.get("SELECT id FROM folders WHERE role = 'inbox'")).id;
    expect((await listMessages(fx.db, { folderId: inbox, attachments: 'with' })).map((m) => m.id)).toEqual([fx.ids.invoice]);
    expect(await countMessages(fx.db, { folderId: inbox, attachments: 'without' })).toBe(1);
    expect(await countThreads(fx.db, { folderId: inbox, attachments: 'with' })).toBe(1);
  });
});
