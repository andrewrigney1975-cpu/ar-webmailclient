import { describe, expect, it, vi } from 'vitest';
import { listFolders } from '../src/js/db/repo-folders.js';
import { countMessages, getMessages, knownUids, listMessages } from '../src/js/db/repo-messages.js';
import { insertAccount } from '../src/js/db/repo-accounts.js';
import { createMessageActions } from '../src/js/mail/actions.js';
import { syncFolder, syncFolderList } from '../src/js/mail/sync.js';
import { createStore } from '../src/js/store.js';
import { syncFixture, testAccount } from './helpers.js';

async function fixture() {
  const fx = await syncFixture();
  await syncFolderList(fx);
  const folders = await listFolders(fx.db);
  const inbox = folders.find((f) => f.role === 'inbox');
  await syncFolder({ ...fx, folder: inbox });
  const store = createStore({ accounts: [fx.account], folders: await listFolders(fx.db), dataVersion: 0 });
  const actions = createMessageActions({ db: fx.db, mail: fx.mail, store });
  const byRole = async (role) => (await listFolders(fx.db)).find((f) => f.role === role);
  const idsIn = async (folder) => (await listMessages(fx.db, { folderId: folder.id })).map((m) => m.id);
  return { ...fx, store, actions, inbox, byRole, idsIn };
}

describe('message actions', () => {
  it('marks messages read and unread locally, on the server and in counts', async () => {
    const fx = await fixture();
    const [first] = await listMessages(fx.db, { folderId: fx.inbox.id, sort: 'dateReceived', descending: false });

    await fx.actions.markRead([first.id]);
    expect((await getMessages(fx.db, [first.id]))[0].isRead).toBe(true);
    expect((await fx.byRole('inbox')).unreadCount).toBe(3);
    expect((await fx.mail.fetchFlags(fx.account, 'INBOX', { uids: [first.uid] }))[0].flags).toContain('\\Seen');

    await fx.actions.markRead([first.id], false);
    expect((await fx.byRole('inbox')).unreadCount).toBe(4);
    expect(fx.store.get().dataVersion).toBeGreaterThan(0);
  });

  it('rolls back a flag change the server rejects', async () => {
    const fx = await fixture();
    const message = (await listMessages(fx.db, { folderId: fx.inbox.id })).find((m) => !m.isFlagged);
    vi.spyOn(fx.mail, 'setFlags').mockRejectedValue(new Error('offline'));

    await expect(fx.actions.setFlagged([message.id])).rejects.toThrow('offline');
    const [after] = await getMessages(fx.db, [message.id]);
    expect(after.isFlagged).toBe(message.isFlagged);
  });

  it('archives with the new UID kept locally, and undoes the move', async () => {
    const fx = await fixture();
    const archive = await fx.byRole('archive');
    const [message] = await listMessages(fx.db, { folderId: fx.inbox.id });

    const token = await fx.actions.archive([message.id]);

    expect(token).toMatchObject({ count: 1, undoable: true });
    expect(await fx.idsIn(fx.inbox)).not.toContain(message.id);
    expect(await fx.idsIn(archive)).toEqual([message.id]);
    expect(await knownUids(fx.db, archive.id)).toEqual([token.moves[0].newUid]);
    expect((await fx.mail.fetchEnvelopes(fx.account, 'Archive', { latest: 5 })).map((e) => e.subject)).toEqual([
      message.subject,
    ]);

    await fx.actions.undo(token);
    expect(await fx.idsIn(archive)).toEqual([]);
    expect(await fx.idsIn(fx.inbox)).toContain(message.id);
    expect(await countMessages(fx.db, { folderId: fx.inbox.id })).toBe(5);
  });

  it('moves unread counts with the message', async () => {
    const fx = await fixture();
    const unread = (await listMessages(fx.db, { folderId: fx.inbox.id })).find((m) => !m.isRead);

    await fx.actions.trash([unread.id]);

    expect((await fx.byRole('inbox')).unreadCount).toBe(3);
    expect((await fx.byRole('trash')).unreadCount).toBe(1);
  });

  it('puts messages back when the server move fails', async () => {
    const fx = await fixture();
    const [message] = await listMessages(fx.db, { folderId: fx.inbox.id });
    vi.spyOn(fx.mail, 'moveMessages').mockRejectedValue(new Error('offline'));

    await expect(fx.actions.trash([message.id])).rejects.toThrow('offline');
    const [after] = await getMessages(fx.db, [message.id]);
    expect(after).toMatchObject({ folderId: fx.inbox.id, uid: message.uid });
    expect((await fx.byRole('inbox')).unreadCount).toBe(4);
  });

  it('drops the local copy when the server gives no new UID, and a later sync fetches it', async () => {
    const fx = await fixture();
    const archive = await fx.byRole('archive');
    const [message] = await listMessages(fx.db, { folderId: fx.inbox.id });
    const move = fx.mail.moveMessages.bind(fx.mail);
    vi.spyOn(fx.mail, 'moveMessages').mockImplementation(async (...args) => (await move(...args)).map(() => null));

    const token = await fx.actions.archive([message.id]);
    expect(token.undoable).toBe(false);
    expect(await fx.idsIn(archive)).toEqual([]);

    await syncFolder({ ...fx, folder: archive });
    expect((await listMessages(fx.db, { folderId: archive.id })).map((m) => m.subject)).toEqual([message.subject]);
  });

  it('moves messages from several accounts to each account’s own folder', async () => {
    const fx = await fixture();
    const second = testAccount();
    await insertAccount(fx.db, second);
    await fx.mail.setCredentials(second.id, 'secret');
    await syncFolderList({ ...fx, account: second });
    const secondInbox = (await listFolders(fx.db, second.id)).find((f) => f.role === 'inbox');
    await syncFolder({ ...fx, account: second, folder: secondInbox });
    fx.store.set({ accounts: [fx.account, second], folders: await listFolders(fx.db) });

    const ids = (await listMessages(fx.db, { unified: true, limit: 2 })).map((m) => m.id);
    const accountsOf = (await getMessages(fx.db, ids)).map((m) => m.accountId);
    expect(new Set(accountsOf).size).toBe(2);

    await fx.actions.archive(ids);
    const archived = await getMessages(fx.db, ids);
    for (const m of archived) {
      const folder = fx.store.get().folders.find((f) => f.id === m.folderId);
      expect(folder).toMatchObject({ role: 'archive', accountId: m.accountId });
    }
  });

  it('deletes forever', async () => {
    const fx = await fixture();
    const [message] = await listMessages(fx.db, { folderId: fx.inbox.id });
    await fx.actions.trash([message.id]);

    await fx.actions.deleteForever([message.id]);

    expect(await getMessages(fx.db, [message.id])).toEqual([]);
    expect(await fx.mail.fetchEnvelopes(fx.account, 'Trash', { latest: 5 })).toEqual([]);
  });

  it('reports a missing archive folder', async () => {
    const fx = await fixture();
    fx.store.set({ folders: fx.store.get().folders.filter((f) => f.role !== 'archive') });
    const [message] = await listMessages(fx.db, { folderId: fx.inbox.id });
    await expect(fx.actions.archive([message.id])).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
  });
});
