import { describe, expect, it, vi } from 'vitest';
import { backgroundConfig, createNotifications } from '../src/js/notify/notifications.js';
import { listFolders } from '../src/js/db/repo-folders.js';
import { getMessage, listMessages } from '../src/js/db/repo-messages.js';
import { syncFolder, syncFolderList } from '../src/js/mail/sync.js';
import { createStore } from '../src/js/store.js';
import { DEFAULT_SETTINGS } from '../src/js/settings.js';
import { deliver, syncFixture } from './helpers.js';

async function fixture() {
  const fx = await syncFixture();
  await syncFolderList(fx);
  const inbox = (await listFolders(fx.db)).find((f) => f.role === 'inbox');
  await syncFolder({ ...fx, folder: inbox });
  const account = { ...fx.account, notify: true };
  const store = createStore({ accounts: [account], folders: await listFolders(fx.db), settings: { ...DEFAULT_SETTINGS } });
  const router = { navigate: vi.fn() };
  const syncManager = {
    syncFolderIfStale: vi.fn(async () => {}),
    reloadFolders: vi.fn(async () => store.set({ folders: await listFolders(fx.db) })),
  };
  const calls = { configure: [], marked: [], unread: [] };
  const prefetched = [];
  let tapped = null;
  const mail = {
    ...fx.mail,
    configureBackgroundSync: vi.fn(async (config) => calls.configure.push(config)),
    markNotified: vi.fn(async (args) => calls.marked.push(args)),
    setUnreadCounts: vi.fn(async (counts) => calls.unread.push(counts)),
    takePrefetched: vi.fn(async () => prefetched.splice(0)),
    addNotificationListener: vi.fn(async (callback) => {
      tapped = callback;
    }),
  };
  const notifications = createNotifications({ db: fx.db, mail, store, router, syncManager });
  return { ...fx, store, router, syncManager, calls, prefetched, notifications, tap: (event) => tapped(event), inbox };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('backgroundConfig', () => {
  it('describes each account with its inbox, archive, accent and settings', async () => {
    const fx = await fixture();
    const config = backgroundConfig(fx.store.get());
    expect(config).toMatchObject({
      intervalMinutes: 15,
      push: false,
      accounts: [
        { notify: true, inboxPath: 'INBOX', archivePath: 'Archive', trashPath: 'Trash', accentColor: '#3867d6', account: { id: fx.account.id } },
      ],
      blocked: { addresses: [], domains: [] },
    });
    expect(config.accounts[0].account).not.toHaveProperty('accentColor');
  });

  it('leaves out accounts that have not synced a folder list yet', () => {
    expect(backgroundConfig({ accounts: [{ id: 'x' }], folders: [], settings: DEFAULT_SETTINGS }).accounts).toEqual([]);
  });
});

describe('notifications controller', () => {
  it('configures the native side on start and only when something changes', async () => {
    const fx = await fixture();
    await fx.notifications.start();
    expect(fx.calls.configure).toHaveLength(1);

    fx.store.set({ settings: { ...fx.store.get().settings } }); // same values, new object
    await settle();
    expect(fx.calls.configure).toHaveLength(1);

    fx.store.set({ settings: { ...fx.store.get().settings, instantNotifications: true } });
    await settle();
    expect(fx.calls.configure.at(-1).push).toBe(true);
  });

  it('marks each inbox seen up to UIDNEXT after a sync, once per change', async () => {
    const fx = await fixture();
    await fx.notifications.start();
    fx.store.set({ folders: [...fx.store.get().folders] });
    await settle();
    fx.store.set({ folders: [...fx.store.get().folders] });
    await settle();
    expect(fx.calls.marked).toEqual([{ accountId: fx.account.id, uidValidity: 1, uid: 5 }]);
  });

  it('passes Inbox unread counts on for the app icon badge, only when they change', async () => {
    const fx = await fixture();
    await fx.notifications.start();
    const inbox = fx.store.get().folders.find((f) => f.role === 'inbox');
    expect(inbox.unreadCount).toBeGreaterThan(0);
    expect(fx.calls.unread).toEqual([{ [fx.account.id]: inbox.unreadCount }]);

    fx.store.set({ folders: [...fx.store.get().folders] });
    await settle();
    expect(fx.calls.unread).toHaveLength(1);

    fx.store.set({ folders: fx.store.get().folders.map((f) => (f.role === 'inbox' ? { ...f, unreadCount: 0 } : f)) });
    await settle();
    expect(fx.calls.unread.at(-1)).toEqual({ [fx.account.id]: 0 });
  });

  it('opens the conversation, or a reply, for a tapped notification', async () => {
    const fx = await fixture();
    await fx.notifications.start();
    const message = (await listMessages(fx.db, { folderId: fx.inbox.id })).find((m) => m.uid === 3);

    await fx.tap({ action: 'open', accountId: fx.account.id, path: 'INBOX', uid: 3 });
    expect(fx.router.navigate).toHaveBeenLastCalledWith({
      name: 'mailbox',
      folderId: String(fx.inbox.id),
      threadId: message.threadId ?? `m:${message.id}`,
    });

    await fx.tap({ action: 'reply', accountId: fx.account.id, path: 'INBOX', uid: 3 });
    expect(fx.router.navigate).toHaveBeenLastCalledWith({ name: 'compose', mode: 'reply', id: String(message.id) });
  });

  it('syncs the folder when the tapped message is not cached yet, then falls back to the inbox', async () => {
    const fx = await fixture();
    await fx.notifications.start();
    await fx.tap({ action: 'open', accountId: fx.account.id, path: 'INBOX', uid: 999 });
    expect(fx.store.get().folders.length).toBeGreaterThan(0);
    expect(fx.router.navigate).toHaveBeenLastCalledWith({ name: 'mailbox', folderId: 'unified', threadId: null });
  });
});

describe('messages prefetched for notifications', () => {
  /** A message delivered to the server and fetched in full, as the native background check does. */
  async function prefetch(fx, overrides, { uidValidity = 1 } = {}) {
    const uid = deliver(fx.plugin, fx.account, 'INBOX', overrides);
    const [envelope] = (await fx.mail.fetchEnvelopes(fx.account, 'INBOX', { fromUid: uid })).filter((e) => e.uid === uid);
    const body = await fx.mail.fetchBody(fx.account, 'INBOX', uid);
    fx.prefetched.push({ accountId: fx.account.id, path: 'INBOX', uidValidity, envelope, body });
    return uid;
  }

  it('opens a tapped message from its prefetched copy, body included, without syncing', async () => {
    const fx = await fixture();
    await fx.notifications.start();
    const uid = await prefetch(fx, { subject: 'Cake time', body: { text: 'Your order is ready', html: null, attachments: [] } });
    const unreadBefore = fx.store.get().folders.find((f) => f.role === 'inbox').unreadCount;

    await fx.tap({ action: 'open', accountId: fx.account.id, path: 'INBOX', uid });

    expect(fx.syncManager.syncFolderIfStale).not.toHaveBeenCalled();
    const message = (await listMessages(fx.db, { folderId: fx.inbox.id })).find((m) => m.uid === uid);
    expect(await getMessage(fx.db, message.id)).toMatchObject({ subject: 'Cake time', bodyText: 'Your order is ready' });
    expect(fx.router.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: String(fx.inbox.id) }));
    const inbox = fx.store.get().folders.find((f) => f.role === 'inbox');
    expect(inbox.unreadCount).toBe(unreadBefore + 1);
  });

  it('drops copies for a folder whose UIDVALIDITY changed', async () => {
    const fx = await fixture();
    await prefetch(fx, { subject: 'Stale' }, { uidValidity: 99 });
    await fx.notifications.start();
    expect((await listMessages(fx.db, { folderId: fx.inbox.id })).map((m) => m.subject)).not.toContain('Stale');
  });

  it('still syncs mail that arrived before a prefetched message', async () => {
    const fx = await fixture();
    const earlier = deliver(fx.plugin, fx.account, 'INBOX', { subject: 'Read elsewhere', flags: ['\\Seen'] });
    await prefetch(fx, { subject: 'Notified' });
    await fx.notifications.start();

    await syncFolder({ ...fx, folder: (await listFolders(fx.db)).find((f) => f.role === 'inbox') });

    const uids = (await listMessages(fx.db, { folderId: fx.inbox.id })).map((m) => m.uid);
    expect(uids).toContain(earlier);
    expect(new Set(uids).size).toBe(uids.length);
  });
});

describe('last background check summary', () => {
  it('says whether Android has run a check, when, and what it found', async () => {
    const { lastCheckSummary } = await import('../src/js/views/settings.js');
    const now = Date.UTC(2026, 8, 28, 6, 0);
    expect(lastCheckSummary(null)).toMatch(/^Not yet/);
    expect(lastCheckSummary({ lastCheckAt: null })).toMatch(/^Not yet/);
    expect(lastCheckSummary({ lastCheckAt: now - 20 * 60_000, lastCheckTrigger: 'scheduled', lastCheckNew: 2 }, now)).toMatch(
      /\(20 min ago\), scheduled check: 2 new$/,
    );
    expect(lastCheckSummary({ lastCheckAt: now - 3 * 3600_000, lastCheckTrigger: 'instant', lastCheckNew: 0 }, now)).toMatch(
      /\(3 h ago\), instant notification: no new mail$/,
    );
    expect(lastCheckSummary({ lastCheckAt: now, lastCheckTrigger: 'manual', lastCheckError: 'a@b.c: Could not connect' }, now)).toMatch(
      /checked now: failed: a@b.c: Could not connect$/,
    );
  });
});
