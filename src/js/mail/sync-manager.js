/**
 * Decides when to sync and reports progress to the store:
 *   - on start, when the app returns to the foreground, and when the network comes back
 *   - every few minutes while the app is open
 *   - when the user opens a folder that hasn't synced recently
 * Background sync while the app is closed arrives with notifications (milestone 8).
 *
 * store.sync is { [accountId]: { state: 'idle' | 'syncing' | 'error', error, lastSyncedAt } }.
 * store.dataVersion increases whenever cached mail changes, so views can reload.
 */
import { listFolders } from '../db/repo-folders.js';
import { AUTO_SYNC_ROLES, syncFolder, syncFolderList } from './sync.js';

export const FOREGROUND_INTERVAL_MS = 5 * 60_000;
export const FOLDER_STALE_MS = 2 * 60_000;

/** `onSynced(account)` runs after a sync that changed cached mail (blocking.js moves blocked senders' mail). */
export function createSyncManager({ db, mail, store, onSynced = async () => {} }) {
  const running = new Map();
  let timer = null;

  function setAccountState(accountId, patch) {
    store.set((state) => ({
      sync: { ...state.sync, [accountId]: { ...state.sync[accountId], ...patch } },
    }));
  }

  function bumpDataVersion() {
    store.set((state) => ({ dataVersion: state.dataVersion + 1 }));
  }

  async function reloadFolders() {
    store.set({ folders: await listFolders(db) });
  }

  async function runAccount(account, folderFilter) {
    setAccountState(account.id, { state: 'syncing' });
    try {
      await syncFolderList({ db, mail, account });
      const folders = (await listFolders(db, account.id)).filter((f) => f.selectable && folderFilter(f));
      let changed = false;
      for (const folder of folders) {
        const result = await syncFolder({ db, mail, account, folder });
        changed ||= result.added.length > 0 || result.removed.length > 0 || result.reset || !result.unchanged;
      }
      await reloadFolders();
      if (changed) {
        bumpDataVersion();
        await onSynced(account);
      }
      setAccountState(account.id, { state: 'idle', error: null, lastSyncedAt: Date.now() });
    } catch (error) {
      setAccountState(account.id, { state: 'error', error: { code: error.code, message: error.message } });
    }
  }

  /** Syncs one account; concurrent requests for the same account share one run. */
  function syncAccount(account, folderFilter = (f) => AUTO_SYNC_ROLES.includes(f.role)) {
    if (!running.has(account.id)) {
      const run = runAccount(account, folderFilter).finally(() => running.delete(account.id));
      running.set(account.id, run);
    }
    return running.get(account.id);
  }

  async function syncAll() {
    await Promise.allSettled(store.get().accounts.map((account) => syncAccount(account)));
  }

  /** Syncs a folder the user opened, unless it synced within FOLDER_STALE_MS. */
  async function syncFolderIfStale(folderId, { force = false } = {}) {
    const { accounts, folders } = store.get();
    const folder = folders.find((f) => f.id === folderId);
    const account = folder && accounts.find((a) => a.id === folder.accountId);
    if (!folder || !account) return;
    if (!force && folder.lastSyncedAt && Date.now() - folder.lastSyncedAt < FOLDER_STALE_MS) return;
    await running.get(account.id);
    await syncAccount(account, (f) => f.id === folderId);
  }

  return {
    syncAll,
    syncAccount,
    syncFolderIfStale,
    reloadFolders,

    start() {
      clearInterval(timer);
      timer = setInterval(syncAll, FOREGROUND_INTERVAL_MS);
      return syncAll();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
