import { describe, expect, it } from 'vitest';
import { insertAccount } from '../src/js/db/repo-accounts.js';
import { listFolders, replaceFolders } from '../src/js/db/repo-folders.js';
import { saveBody, saveEnvelopes } from '../src/js/db/repo-messages.js';
import {
  countThreads,
  listThreads,
  messageIdsInThreads,
  threadMessages,
  unreadIdsInThreads,
} from '../src/js/db/repo-threads.js';
import { threadNewMessages } from '../src/js/mail/threading.js';
import { testAccount, testDatabase } from './helpers.js';

let uid = 0;
const envelope = (id, { refs = [], date, from = 'bob@example.org', flags = [], subject = 'Plans', attach = false } = {}) => ({
  uid: ++uid,
  messageId: id,
  inReplyTo: refs.at(-1) ?? null,
  references: refs,
  subject,
  from: [{ name: from.split('@')[0], address: from }],
  to: [{ name: null, address: 'me@example.com' }],
  cc: [],
  replyTo: [],
  dateSent: date,
  dateReceived: date,
  size: 100,
  flags,
  hasAttachments: attach,
});

async function fixture() {
  const db = await testDatabase();
  const account = testAccount({ email: 'me@example.com' });
  await insertAccount(db, account);
  const folder = (path, role) => ({ path, name: path, role, attributes: [], subscribed: true, selectable: true });
  await db.transaction((tx) =>
    replaceFolders(tx, account.id, [folder('INBOX', 'inbox'), folder('Sent', 'sent'), folder('Trash', 'trash'), folder('Archive', 'archive')]),
  );
  const folders = Object.fromEntries((await listFolders(db, account.id)).map((f) => [f.role, f]));
  const add = (role, ...envelopes) =>
    db.transaction(async (tx) => {
      await saveEnvelopes(tx, folders[role], envelopes);
      await threadNewMessages(tx, account.id);
    });

  // Conversation 1: Bob -> me (reply from Sent) -> Zoë; one message deleted to Trash.
  await add('inbox', envelope('<a>', { date: 1, attach: true, flags: ['\\Seen'] }));
  await add('sent', envelope('<b>', { refs: ['<a>'], date: 2, from: 'me@example.com', flags: ['\\Seen'] }));
  await add('inbox', envelope('<c>', { refs: ['<a>', '<b>'], date: 3, from: 'zoe@example.net' }));
  await add('trash', envelope('<d>', { refs: ['<a>'], date: 4, from: 'spam@example.net', flags: ['\\Flagged'] }));
  // Conversation 2: a single read message, newer.
  await add('inbox', envelope('<solo>', { date: 10, subject: 'Other', flags: ['\\Seen'] }));
  // Same message also in Archive (a copy).
  await add('archive', envelope('<c>', { refs: ['<a>', '<b>'], date: 3, from: 'zoe@example.net' }));

  return { db, account, folders };
}

describe('conversations', () => {
  it('lists one row per conversation with summaries from all folders except Trash', async () => {
    const { db, folders } = await fixture();
    expect(await countThreads(db, { folderId: folders.inbox.id })).toBe(2);

    const [solo, plans] = await listThreads(db, { folderId: folders.inbox.id });
    expect(solo).toMatchObject({ subject: 'Other', isRead: true, thread: { count: 1 } });
    expect(plans).toMatchObject({
      subject: 'Plans',
      from: { address: 'zoe@example.net' }, // newest in this folder
      isRead: false,
      isFlagged: false, // the flagged message is in Trash
      hasAttachments: true,
      thread: { count: 3 },
    });
    expect(plans.thread.participants.map((p) => p.address)).toEqual([
      'bob@example.org',
      'me@example.com',
      'zoe@example.net',
    ]);
  });

  it('includes Trash messages when viewing Trash', async () => {
    const { db, folders } = await fixture();
    const [row] = await listThreads(db, { folderId: folders.trash.id });
    expect(row).toMatchObject({ isFlagged: true, thread: { count: 4 } });
  });

  it('sorts conversations', async () => {
    const { db, folders } = await fixture();
    const oldestFirst = await listThreads(db, { folderId: folders.inbox.id, descending: false });
    expect(oldestFirst.map((r) => r.subject)).toEqual(['Plans', 'Other']);
  });

  it('builds the unified inbox from conversations', async () => {
    const { db } = await fixture();
    expect(await countThreads(db, { unified: true })).toBe(2);
  });

  it('loads a conversation oldest first, without duplicates or Trash', async () => {
    const { db, folders } = await fixture();
    const [, plans] = await listThreads(db, { folderId: folders.inbox.id });
    const inboxCopy = (await db.get("SELECT id FROM messages WHERE message_id = '<c>' AND folder_id = ?", [folders.inbox.id])).id;
    await saveBody(db, inboxCopy, { text: 'hi', html: null, snippet: 'hi' });

    const messages = await threadMessages(db, plans.threadKey);
    expect(messages.map((m) => m.messageId)).toEqual(['<a>', '<b>', '<c>']);
    expect(messages[2].id).toBe(inboxCopy); // the copy with a cached body

    const withTrash = await threadMessages(db, plans.threadKey, { includeHidden: true });
    expect(withTrash.map((m) => m.messageId)).toEqual(['<a>', '<b>', '<c>', '<d>']);
  });

  it('finds the messages to act on in the current folder', async () => {
    const { db, folders } = await fixture();
    const [, plans] = await listThreads(db, { folderId: folders.inbox.id });
    const inInbox = await messageIdsInThreads(db, [plans.threadKey], { folderId: folders.inbox.id });
    const rows = await db.all(`SELECT message_id FROM messages WHERE id IN (${inInbox.join(',')}) ORDER BY message_id`);
    expect(rows.map((r) => r.message_id)).toEqual(['<a>', '<c>']);

    const unread = await unreadIdsInThreads(db, [plans.threadKey]);
    expect(unread).toHaveLength(2); // <c> in Inbox and its copy in Archive; not the Trash one
  });
});
