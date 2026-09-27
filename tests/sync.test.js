import { describe, expect, it, vi } from 'vitest';
import { getFolder, listFolders } from '../src/js/db/repo-folders.js';
import { knownUids, listMessages } from '../src/js/db/repo-messages.js';
import { getContact } from '../src/js/db/repo-contacts.js';
import { INITIAL_SYNC_COUNT, syncFolder, syncFolderList } from '../src/js/mail/sync.js';
import { createSyncManager } from '../src/js/mail/sync-manager.js';
import { createStore } from '../src/js/store.js';
import { deliver, syncFixture } from './helpers.js';

async function inbox(db, account) {
  return (await listFolders(db, account.id)).find((f) => f.role === 'inbox');
}

async function syncInbox({ db, mail, account }) {
  const result = await syncFolder({ db, mail, account, folder: await inbox(db, account) });
  return { result, folder: await inbox(db, account) };
}

describe('syncFolder', () => {
  it('does an initial sync of folders, envelopes, counts and contacts', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);

    const folders = await listFolders(fx.db, fx.account.id);
    expect(folders.map((f) => f.role)).toEqual(['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']);

    const { result, folder } = await syncInbox(fx);
    expect(result.added).toHaveLength(5);
    expect(folder).toMatchObject({ totalCount: 5, unreadCount: 4, uidNext: 6, uidValidity: 1 });
    expect(folder.lastSyncedAt).toBeTypeOf('number');

    const messages = await listMessages(fx.db, { folderId: folder.id });
    expect(messages.map((m) => m.subject)).toEqual([
      'Re: Project kickoff',
      'This week in tech',
      'Invoice #1042',
      'Re: Project kickoff',
      'Project kickoff',
    ]);
    expect(messages.find((m) => m.subject === 'Invoice #1042')).toMatchObject({ hasAttachments: true, isRead: true });

    expect(await getContact(fx.db, 'bob@example.org')).toMatchObject({ name: 'Bob Smith', times_received_from: 3 });
  });

  it('fetches only new messages, refreshes flags and removes expunged ones', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);
    await syncInbox(fx);

    const newUid = deliver(fx.plugin, fx.account, 'INBOX');
    await fx.mail.setFlags(fx.account, 'INBOX', [1], { add: ['\\Seen'] });
    await fx.mail.moveMessages(fx.account, 'INBOX', [2], 'Archive');
    const fetchEnvelopes = vi.spyOn(fx.mail, 'fetchEnvelopes');

    const { result, folder } = await syncInbox(fx);

    expect(fetchEnvelopes).toHaveBeenCalledWith(fx.account, 'INBOX', { fromUid: 6 });
    expect(result.added.map((e) => e.uid)).toEqual([newUid]);
    expect(result.removed).toEqual([2]);
    expect(await knownUids(fx.db, folder.id)).toEqual([1, 3, 4, 5, newUid]);
    const [first] = (await listMessages(fx.db, { folderId: folder.id, sort: 'dateReceived', descending: false }));
    expect(first).toMatchObject({ uid: 1, isRead: true });
  });

  it('does not re-add the newest message when nothing is new', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);
    await syncInbox(fx);
    // Simulate a server where UIDNEXT jumped without new mail, so "6:*" returns UID 5.
    fx.plugin.mailboxes.get(fx.account.id).get('INBOX').uidNext = 9;

    const { result } = await syncInbox(fx);
    expect(result.added).toEqual([]);
  });

  it('starts over when UIDVALIDITY changes', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);
    await syncInbox(fx);

    const remote = fx.plugin.mailboxes.get(fx.account.id).get('INBOX');
    remote.uidValidity = 2;
    remote.messages = remote.messages.slice(0, 2);

    const { result, folder } = await syncInbox(fx);
    expect(result.reset).toBe(true);
    expect(await knownUids(fx.db, folder.id)).toEqual([1, 2]);
    expect(folder.uidValidity).toBe(2);
  });

  it('skips work when CONDSTORE says nothing changed', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);
    const status = vi.spyOn(fx.mail, 'folderStatus');
    status.mockImplementation(async () => ({
      path: 'INBOX', uidValidity: 1, uidNext: 6, highestModSeq: 42, messages: 5, unseen: 4,
    }));
    await syncInbox(fx);
    const fetchFlags = vi.spyOn(fx.mail, 'fetchFlags');

    const { result } = await syncInbox(fx);
    expect(result.unchanged).toBe(true);
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('only fetches the newest messages after a large gap', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);
    await syncInbox(fx);
    for (let i = 0; i < INITIAL_SYNC_COUNT + 5; i++) deliver(fx.plugin, fx.account, 'INBOX');

    const { result } = await syncInbox(fx);
    expect(result.added).toHaveLength(INITIAL_SYNC_COUNT);
    expect(result.added.at(-1).uid).toBe(5 + INITIAL_SYNC_COUNT + 5);
  });

  it('counts recipients of sent mail as contacts', async () => {
    const fx = await syncFixture();
    await syncFolderList(fx);
    await fx.mail.send(
      fx.account,
      { from: { address: fx.account.email }, to: [{ name: 'Priya', address: 'priya@example.org' }], subject: 'Hi', text: 'x' },
      { sentFolder: 'Sent' },
    );
    const sent = (await listFolders(fx.db, fx.account.id)).find((f) => f.role === 'sent');
    await syncFolder({ ...fx, folder: sent });
    expect(await getContact(fx.db, 'priya@example.org')).toMatchObject({ times_sent_to: 1, times_received_from: 0 });
  });
});

describe('sync manager', () => {
  function managerFixture(fx) {
    const store = createStore({ accounts: [fx.account], folders: [], sync: {}, dataVersion: 0 });
    return { store, manager: createSyncManager({ db: fx.db, mail: fx.mail, store }) };
  }

  it('syncs inbox and sent for every account and reports state', async () => {
    const fx = await syncFixture();
    const { store, manager } = managerFixture(fx);

    await manager.syncAll();

    const state = store.get();
    expect(state.sync[fx.account.id]).toMatchObject({ state: 'idle', error: null });
    expect(state.dataVersion).toBe(1);
    expect(state.folders.filter((f) => f.lastSyncedAt).map((f) => f.role)).toEqual(['inbox', 'sent']);
  });

  it('records errors per account', async () => {
    const fx = await syncFixture();
    await fx.mail.setCredentials(fx.account.id, 'wrong');
    const { store, manager } = managerFixture(fx);

    await manager.syncAll();

    expect(store.get().sync[fx.account.id]).toMatchObject({ state: 'error', error: { code: 'AUTH_FAILED' } });
  });

  it('shares one run between concurrent requests', async () => {
    const fx = await syncFixture();
    const { manager } = managerFixture(fx);
    const listFoldersSpy = vi.spyOn(fx.mail, 'listFolders');

    await Promise.all([manager.syncAccount(fx.account), manager.syncAccount(fx.account)]);
    expect(listFoldersSpy).toHaveBeenCalledOnce();
  });

  it('syncs an opened folder only when stale', async () => {
    const fx = await syncFixture();
    const { store, manager } = managerFixture(fx);
    await manager.syncAll();
    const archive = store.get().folders.find((f) => f.role === 'archive');
    expect(archive.lastSyncedAt).toBeNull();

    await manager.syncFolderIfStale(archive.id);
    expect((await getFolder(fx.db, archive.id)).lastSyncedAt).toBeTypeOf('number');

    const status = vi.spyOn(fx.mail, 'folderStatus');
    await manager.syncFolderIfStale(archive.id);
    expect(status).not.toHaveBeenCalled();
  });
});
