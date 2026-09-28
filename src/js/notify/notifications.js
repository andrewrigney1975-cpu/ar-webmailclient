/**
 * Notifications, JS side (PLAN.md §4.4). Background checking itself is
 * native (SyncWorker / PushService); this module:
 *   - keeps the native side's account list and schedule in step with the app
 *   - after each sync, tells it the inbox has been seen, so mail already shown
 *     in the app isn't notified and stale notifications clear
 *   - passes each Inbox's unread count on for the app icon badge
 *   - opens the right conversation (or a reply) when a notification is tapped
 *   - asks for the notification permission once, after the first account
 */
import { Preferences } from '@capacitor/preferences';
import { toNativeAccount } from '../mail/bridge.js';

const ASKED_KEY = 'askedNotificationPermission';

/** What the native background checker needs for each account. */
export function backgroundConfig({ accounts, folders, settings }) {
  const pathOf = (accountId, role) => folders.find((f) => f.accountId === accountId && f.role === role)?.path ?? null;
  return {
    accounts: accounts
      .filter((a) => pathOf(a.id, 'inbox'))
      .map((a) => ({
        account: toNativeAccount(a),
        notify: a.notify,
        inboxPath: pathOf(a.id, 'inbox'),
        archivePath: pathOf(a.id, 'archive'),
        accentColor: a.accentColor,
      })),
    intervalMinutes: settings.syncIntervalMinutes,
    push: settings.instantNotifications,
  };
}

export function createNotifications({ db, mail, store, router, syncManager, onError = () => {} }) {
  let lastConfig = null;
  let lastCounts = null;
  const lastMarked = new Map();

  /** Inbox unread per account; native sums the accounts with notifications on. */
  async function sendUnreadCounts() {
    const counts = Object.fromEntries(
      store.get().folders.filter((f) => f.role === 'inbox').map((f) => [f.accountId, f.unreadCount ?? 0]),
    );
    const json = JSON.stringify(counts);
    if (json === lastCounts) return;
    lastCounts = json;
    await mail.setUnreadCounts(counts).catch(() => {});
  }

  async function configure() {
    const config = backgroundConfig(store.get());
    const json = JSON.stringify(config);
    if (json === lastConfig) return;
    lastConfig = json;
    await mail.configureBackgroundSync(config).catch(onError);
  }

  /** After a sync, everything in each inbox up to UIDNEXT has been in front of the user. */
  async function markInboxesSeen() {
    for (const folder of store.get().folders.filter((f) => f.role === 'inbox' && f.uidNext)) {
      const key = `${folder.uidValidity}:${folder.uidNext}`;
      if (lastMarked.get(folder.accountId) === key) continue;
      lastMarked.set(folder.accountId, key);
      await mail
        .markNotified({ accountId: folder.accountId, uidValidity: folder.uidValidity, uid: folder.uidNext - 1 })
        .catch(() => {});
    }
  }

  async function findMessage(accountId, path, uid) {
    const folder = store.get().folders.find((f) => f.accountId === accountId && f.path === path);
    if (!folder) return null;
    const lookup = () => db.get('SELECT id, thread_id FROM messages WHERE folder_id = ? AND uid = ?', [folder.id, uid]);
    let row = await lookup();
    if (!row) {
      await syncManager.syncFolderIfStale(folder.id, { force: true });
      row = await lookup();
    }
    return row && { folder, id: row.id, threadKey: row.thread_id ?? `m:${row.id}` };
  }

  async function onTapped({ action, accountId, path, uid }) {
    const found = await findMessage(accountId, path, uid).catch(() => null);
    if (!found) {
      router.navigate({ name: 'mailbox', folderId: 'unified', threadId: null });
      return;
    }
    if (action === 'reply') router.navigate({ name: 'compose', mode: 'reply', id: String(found.id) });
    else router.navigate({ name: 'mailbox', folderId: String(found.folder.id), threadId: found.threadKey });
  }

  return {
    async start() {
      await mail.addNotificationListener((event) => onTapped(event));
      store.subscribe((state, previous) => {
        if (state.accounts !== previous.accounts || state.folders !== previous.folders || state.settings !== previous.settings) {
          configure();
        }
        if (state.folders !== previous.folders) {
          markInboxesSeen();
          sendUnreadCounts();
        }
      });
      await configure();
      await sendUnreadCounts();
    },

    /** Asks once, after the first account is added (Android 13+ needs the runtime permission). */
    async requestPermissionOnce() {
      const { value } = await Preferences.get({ key: ASKED_KEY }).catch(() => ({ value: null }));
      if (value) return;
      await Preferences.set({ key: ASKED_KEY, value: '1' }).catch(() => {});
      await mail.requestNotificationPermission().catch(() => {});
    },

    status: () => mail.notificationStatus(),
    openSystemSettings: () => mail.openNotificationSettings(),
    openBatterySettings: () => mail.openBatterySettings(),
    checkNow: () => mail.checkInBackgroundNow(),
    requestPermission: () => mail.requestNotificationPermission(),
  };
}
