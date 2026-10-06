/**
 * Blocked senders and domains: their mail goes straight to Trash.
 *   - The native background check moves new mail from them before it would
 *     notify (BlockList.kt), using the list in backgroundConfig.
 *   - The app moves any that still reach a cached Inbox: after each sync, and
 *     when a sender is first blocked.
 *
 * store.blocked is [{ kind: 'address' | 'domain', value }].
 */
import { blockedInboxMessageIds, blockSender, listBlocked, unblockSender } from '../db/repo-senders.js';

export function domainOf(address) {
  const at = address?.lastIndexOf('@') ?? -1;
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

/** The block entry covering this address, if any. A domain covers its subdomains. */
export function blockFor(address, blocked) {
  const email = address?.trim().toLowerCase();
  if (!email) return null;
  const domain = domainOf(email);
  return (
    blocked.find((b) => b.kind === 'address' && b.value === email) ??
    blocked.find((b) => b.kind === 'domain' && domain && (domain === b.value || domain.endsWith(`.${b.value}`))) ??
    null
  );
}

export function createBlocking({ db, store, actions, onError = () => {} }) {
  let queue = Promise.resolve(null);

  async function load() {
    store.set({ blocked: await listBlocked(db) });
  }

  /** Moves cached Inbox mail from blocked senders to Trash. Resolves with the number moved. */
  function enforce() {
    queue = queue
      .catch(() => null)
      .then(async () => {
        const ids = await blockedInboxMessageIds(db);
        return ids.length ? ((await actions.trash(ids))?.count ?? 0) : 0;
      });
    return queue.catch((error) => {
      onError(error);
      return 0;
    });
  }

  return {
    load,
    enforce,

    /** Blocks an address or domain and moves its Inbox mail to Trash. Resolves with the number moved. */
    async block(kind, value) {
      await blockSender(db, kind, value);
      await load();
      return enforce();
    },

    async unblock(kind, value) {
      await unblockSender(db, kind, value);
      await load();
    },
  };
}
