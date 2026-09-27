/**
 * "Search the server" (PLAN.md §4.6): runs IMAP SEARCH in each account's
 * main folders, fetches envelopes for matches that aren't cached yet and
 * saves (and threads) them, so the local search then finds them too.
 */
import { knownUids, saveEnvelopes } from '../db/repo-messages.js';
import { threadNewMessages } from '../mail/threading.js';
import { serverCriteria } from './search.js';

export const SERVER_SEARCH_ROLES = ['inbox', 'sent', 'archive', 'all'];

/** Returns the number of messages newly fetched. */
export async function searchServer({ db, mail, store, query, onProgress = () => {} }) {
  const { accounts, folders } = store.get();
  const criteria = serverCriteria(query);
  const targets = folders.filter(
    (f) =>
      f.selectable &&
      (query.folders.length
        ? query.folders.some((name) => [f.role, f.name.toLowerCase(), f.path.toLowerCase()].includes(name))
        : SERVER_SEARCH_ROLES.includes(f.role)),
  );

  let fetched = 0;
  for (const [index, folder] of targets.entries()) {
    const account = accounts.find((a) => a.id === folder.accountId);
    if (!account) continue;
    onProgress({ done: index, total: targets.length, folder });
    const uids = await mail.searchServer(account, folder.path, criteria);
    const cached = new Set(await knownUids(db, folder.id));
    const missing = uids.filter((uid) => !cached.has(uid));
    if (missing.length === 0) continue;
    const envelopes = await mail.fetchEnvelopes(account, folder.path, { uids: missing });
    await db.transaction(async (tx) => {
      await saveEnvelopes(tx, folder, envelopes);
      await threadNewMessages(tx, account.id);
    });
    fetched += envelopes.length;
  }
  onProgress({ done: targets.length, total: targets.length });
  return fetched;
}
