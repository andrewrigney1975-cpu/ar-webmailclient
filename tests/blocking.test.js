import { describe, expect, it } from 'vitest';
import { blockFor, createBlocking, domainOf } from '../src/js/mail/blocking.js';
import { listFolders } from '../src/js/db/repo-folders.js';
import { listMessages } from '../src/js/db/repo-messages.js';
import { createMessageActions } from '../src/js/mail/actions.js';
import { syncFolder, syncFolderList } from '../src/js/mail/sync.js';
import { createStore } from '../src/js/store.js';
import { deliver, syncFixture } from './helpers.js';

describe('blockFor', () => {
  const blocked = [
    { kind: 'address', value: 'spam@example.org' },
    { kind: 'domain', value: 'cheesecake.com.au' },
  ];

  it('matches blocked addresses ignoring case', () => {
    expect(blockFor('Spam@Example.org', blocked)).toEqual(blocked[0]);
    expect(blockFor('friend@example.org', blocked)).toBeNull();
    expect(blockFor(null, blocked)).toBeNull();
  });

  it('matches a blocked domain and its subdomains, not lookalikes', () => {
    expect(blockFor('offers@cheesecake.com.au', blocked)).toEqual(blocked[1]);
    expect(blockFor('news@mail.cheesecake.com.au', blocked)).toEqual(blocked[1]);
    expect(blockFor('a@notcheesecake.com.au', blocked)).toBeNull();
  });

  it('finds the domain of an address', () => {
    expect(domainOf('Offers@Cheesecake.com.au')).toBe('cheesecake.com.au');
    expect(domainOf('nobody')).toBe('');
  });
});

async function fixture() {
  const fx = await syncFixture();
  await syncFolderList(fx);
  const folders = await listFolders(fx.db);
  const inbox = folders.find((f) => f.role === 'inbox');
  const store = createStore({ accounts: [fx.account], folders, dataVersion: 0, blocked: [] });
  const actions = createMessageActions({ db: fx.db, mail: fx.mail, store });
  const blocking = createBlocking({ db: fx.db, store, actions });
  const sync = async () => {
    await syncFolder({ ...fx, folder: (await listFolders(fx.db)).find((f) => f.role === 'inbox') });
    store.set({ folders: await listFolders(fx.db) });
  };
  const inboxSenders = async () => (await listMessages(fx.db, { folderId: inbox.id })).map((m) => m.from.address);
  return { ...fx, store, blocking, sync, inbox, inboxSenders };
}

describe('blocking', () => {
  it('moves Inbox mail from a blocked sender to Trash when blocked', async () => {
    const fx = await fixture();
    deliver(fx.plugin, fx.account, 'INBOX', { from: [{ name: 'The Cheesecake Shop', address: 'offers@cheesecake.com.au' }] });
    await fx.sync();

    const moved = await fx.blocking.block('address', 'Offers@Cheesecake.com.au');

    expect(moved).toBe(1);
    expect(fx.store.get().blocked).toEqual([{ kind: 'address', value: 'offers@cheesecake.com.au' }]);
    expect(await fx.inboxSenders()).not.toContain('offers@cheesecake.com.au');
    const trash = fx.plugin.mailboxes.get(fx.account.id).get('Trash');
    expect(trash.messages.map((m) => m.from[0].address)).toContain('offers@cheesecake.com.au');
  });

  it('moves new mail from a blocked domain when enforced after a sync', async () => {
    const fx = await fixture();
    await fx.sync();
    await fx.blocking.block('domain', 'cheesecake.com.au');
    deliver(fx.plugin, fx.account, 'INBOX', { from: [{ name: null, address: 'news@mail.cheesecake.com.au' }] });
    deliver(fx.plugin, fx.account, 'INBOX', { from: [{ name: null, address: 'friend@example.org' }] });
    await fx.sync();

    expect(await fx.blocking.enforce()).toBe(1);
    const senders = await fx.inboxSenders();
    expect(senders).toContain('friend@example.org');
    expect(senders).not.toContain('news@mail.cheesecake.com.au');
  });

  it('stops moving mail once unblocked', async () => {
    const fx = await fixture();
    await fx.blocking.block('address', 'nia@example.org');
    await fx.blocking.unblock('address', 'nia@example.org');
    expect(fx.store.get().blocked).toEqual([]);
    deliver(fx.plugin, fx.account, 'INBOX');
    await fx.sync();
    expect(await fx.blocking.enforce()).toBe(0);
    expect(await fx.inboxSenders()).toContain('nia@example.org');
  });
});
