/**
 * Performance check with 50,000 messages (PLAN.md milestone 11). Opt-in, because it
 * takes several seconds: PERF=1 npx vitest run tests/perf.test.js
 */
import { expect, it } from 'vitest';
import { testDatabase, testAccount } from './helpers.js';
import { insertAccount } from '../src/js/db/repo-accounts.js';
import { listFolders, replaceFolders } from '../src/js/db/repo-folders.js';
import { saveEnvelopes, listMessages, countMessages } from '../src/js/db/repo-messages.js';
import { listThreads, countThreads } from '../src/js/db/repo-threads.js';
import { threadNewMessages } from '../src/js/mail/threading.js';
import { searchMessages, resetSearchMode } from '../src/js/search/search.js';
import { parseQuery } from '../src/js/search/query-parser.js';

it.runIf(process.env.PERF)('lists, conversations and search stay fast with 50,000 messages', async () => {
  resetSearchMode();
  const db = await testDatabase();
  const account = testAccount();
  await insertAccount(db, account);
  await db.transaction((tx) => replaceFolders(tx, account.id, [{ path: 'INBOX', name: 'INBOX', role: 'inbox', attributes: [], subscribed: true, selectable: true }]));
  const [inbox] = await listFolders(db);
  const N = 50_000;
  const t = {};
  const t0 = performance.now();
  const words = ['invoice', 'meeting', 'report', 'holiday', 'budget', 'lunch', 'project', 'update', 'review', 'contract'];
  for (let batch = 0; batch < N / 1000; batch++) {
    const envelopes = Array.from({ length: 1000 }, (_, j) => {
      const i = batch * 1000 + j;
      const root = i - (i % 4);
      return {
        uid: i + 1, messageId: `<m${i}@x>`, inReplyTo: i % 4 ? `<m${root}@x>` : null, references: i % 4 ? [`<m${root}@x>`] : [],
        subject: `${i % 4 ? 'Re: ' : ''}${words[root % 10]} ${root}`, from: [{ name: `Sender ${i % 300}`, address: `s${i % 300}@example.org` }],
        to: [{ name: null, address: 'me@example.com' }], cc: [], replyTo: [], dateSent: 1.7e12 + i * 60000, dateReceived: 1.7e12 + i * 60000,
        size: 1000 + i, flags: i % 3 ? ['\\Seen'] : [], hasAttachments: i % 7 === 0,
      };
    });
    await db.transaction(async (tx) => { await saveEnvelopes(tx, inbox, envelopes); await threadNewMessages(tx, account.id); });
  }
  t.insertAndThread = performance.now() - t0;
  const time = async (name, fn) => { const s = performance.now(); await fn(); t[name] = Math.round(performance.now() - s); };
  await time('countMessages', () => countMessages(db, { folderId: inbox.id }));
  await time('listMessages first page', () => listMessages(db, { folderId: inbox.id, limit: 50 }));
  await time('listMessages deep page', () => listMessages(db, { folderId: inbox.id, limit: 50, offset: 45_000 }));
  await time('listMessages by sender', () => listMessages(db, { folderId: inbox.id, sort: 'sender', limit: 50 }));
  await time('countThreads', () => countThreads(db, { folderId: inbox.id }));
  await time('listThreads first page', () => listThreads(db, { folderId: inbox.id, limit: 50 }));
  await time('listThreads deep page', () => listThreads(db, { folderId: inbox.id, limit: 50, offset: 12_000 }));
  await time('unified listThreads', () => listThreads(db, { unified: true, limit: 50 }));
  await time('search word', () => searchMessages(db, parseQuery('budget'), { limit: 50 }));
  await time('search from + unread', () => searchMessages(db, parseQuery('from:sender is:unread'), { limit: 50 }));
  t.insertAndThread = Math.round(t.insertAndThread);
  console.log('50k timings (ms)', t);
  // Generous limits for a desktop JVM-less run; the phone is slower, so these guard against regressions.
  for (const [name, ms] of Object.entries(t)) {
    if (name !== 'insertAndThread') expect(ms, name).toBeLessThan(250);
  }
}, 600_000);
