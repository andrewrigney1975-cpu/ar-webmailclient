/**
 * Incremental IMAP sync into the local database (PLAN.md §4.1).
 *
 * Per folder:
 *   1. STATUS. If UIDVALIDITY changed, the cached UIDs are meaningless: start over.
 *   2. With CONDSTORE, an unchanged HIGHESTMODSEQ / UIDNEXT / count means nothing to do.
 *   3. First sync: fetch the newest INITIAL_SYNC_COUNT envelopes.
 *      Later syncs: fetch envelopes above the highest cached UID, then refresh
 *      flags for the cached range; cached UIDs the server no longer has were expunged.
 */
import { replaceFolders, updateFolderSyncState } from '../db/repo-folders.js';
import { clearFolder, deleteUids, knownUids, saveEnvelopes, updateFlags } from '../db/repo-messages.js';
import { recordContacts } from '../db/repo-contacts.js';
import { threadNewMessages } from './threading.js';

export const INITIAL_SYNC_COUNT = 200;

/** Folders synced automatically; others sync when opened. */
export const AUTO_SYNC_ROLES = ['inbox', 'sent'];

export async function syncFolderList({ db, mail, account }) {
  const remote = await mail.listFolders(account);
  await db.transaction((tx) => replaceFolders(tx, account.id, remote));
}

export async function syncFolder({ db, mail, account, folder, now = Date.now() }) {
  const status = await mail.folderStatus(account, folder.path);
  const reset = folder.uidValidity != null && folder.uidValidity !== status.uidValidity;

  const unchanged =
    !reset &&
    status.highestModSeq != null &&
    status.highestModSeq === folder.highestModSeq &&
    status.uidNext === folder.uidNext &&
    status.messages === folder.totalCount;

  const known = reset || unchanged ? [] : await knownUids(db, folder.id);
  let added = [];
  let removed = [];
  let flags = [];

  if (!unchanged) {
    const highest = known.at(-1) ?? 0;
    const missing = status.messages - known.length;

    if (status.messages === 0) {
      removed = known;
    } else if (known.length === 0 || missing > INITIAL_SYNC_COUNT) {
      // First sync, or so much is new that only the newest messages are worth fetching.
      added = (await mail.fetchEnvelopes(account, folder.path, { latest: INITIAL_SYNC_COUNT })).filter(
        (e) => e.uid > highest,
      );
    } else if (status.uidNext > highest + 1) {
      // "highest+1:*" returns the newest message even when it is below the range, so filter.
      added = (await mail.fetchEnvelopes(account, folder.path, { fromUid: highest + 1 })).filter(
        (e) => e.uid > highest,
      );
    }

    if (known.length > 0 && status.messages > 0) {
      flags = await mail.fetchFlags(account, folder.path, { fromUid: known[0], toUid: highest });
      const present = new Set(flags.map((f) => f.uid));
      removed = known.filter((uid) => !present.has(uid));
    }
  }

  await db.transaction(async (tx) => {
    if (reset) await clearFolder(tx, folder.id);
    await saveEnvelopes(tx, folder, added);
    await updateFlags(tx, folder.id, flags);
    await deleteUids(tx, folder.id, removed);

    const outgoing = folder.role === 'sent' || folder.role === 'drafts';
    for (const e of added) {
      if (outgoing) {
        await recordContacts(tx, [...e.to, ...e.cc], 'sent', e.dateSent);
      } else {
        await recordContacts(tx, e.from, 'received', e.dateReceived);
      }
    }

    // Also picks up messages cached before threading existed.
    await threadNewMessages(tx, account.id);

    await updateFolderSyncState(tx, folder.id, {
      uidValidity: status.uidValidity,
      uidNext: status.uidNext,
      highestModSeq: status.highestModSeq,
      totalCount: status.messages,
      unreadCount: status.unseen,
      lastSyncedAt: now,
    });
  });

  return { folderId: folder.id, added, removed, reset, unchanged };
}
