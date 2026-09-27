/**
 * Outbox (PLAN.md §4.1, §4.8). Sent messages wait in SQLite for a few
 * seconds (so they can be undone), then go out; if sending fails they stay
 * and retry with backoff, so composing works offline. Errors that retrying
 * can't fix (bad password, rejected recipient) hold the message until the
 * user edits or retries it.
 *
 * After a send: the reply's original is flagged \Answered (or $Forwarded),
 * recipients are counted for autocomplete, and the draft is removed locally
 * and from the server's Drafts folder.
 */
import { MailErrorCode } from './bridge.js';
import { recordContacts } from '../db/repo-contacts.js';
import { deleteDraft, enqueue, getOutboxItem, listOutbox, recordFailure, removeFromOutbox, rescheduleOutbox } from '../db/repo-drafts.js';
import { getMessage, setLocalFlags } from '../db/repo-messages.js';

export const UNDO_SEND_MS = 5000;
const HOLD = Number.MAX_SAFE_INTEGER;
const PERMANENT = new Set([
  MailErrorCode.AUTH_FAILED,
  MailErrorCode.APP_PASSWORD_REQUIRED,
  MailErrorCode.BASIC_AUTH_DISABLED,
  MailErrorCode.NO_CREDENTIALS,
  MailErrorCode.INVALID_ARGUMENT,
  MailErrorCode.RECIPIENT_REJECTED,
]);

/** Retry delay after `attempts` failures: 30 s, 1 min, 2 min … capped at 30 min. */
export function retryDelay(attempts) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

/** Gmail saves sent mail itself; appending a copy would duplicate it. */
export function savesSentMail(account) {
  return /(^|\.)gmail\.com$|googlemail\.com$/i.test(account.imap.host);
}

export function createOutbox({ db, mail, store, now = () => Date.now(), newId = () => crypto.randomUUID() }) {
  let timer = null;
  let running = null;

  async function refresh() {
    store.set({ outbox: await listOutbox(db) });
  }

  function arm() {
    clearTimeout(timer);
    const next = store.get().outbox.filter((i) => i.sendAfter !== HOLD).map((i) => i.sendAfter);
    if (next.length === 0) return;
    timer = setTimeout(process, Math.max(0, Math.min(...next) - now()) + 50);
  }

  async function markOriginal(item, account) {
    const originalId = item.data.replyOf ?? item.data.forwardOf;
    if (!originalId) return;
    const original = await getMessage(db, originalId);
    const folder = original && store.get().folders.find((f) => f.id === original.folderId);
    if (!original || !folder) return;
    const flag = item.data.replyOf ? '\\Answered' : '$Forwarded';
    if (original.flags.includes(flag)) return;
    await setLocalFlags(db, original.id, [...original.flags, flag]);
    await mail.setFlags(account, folder.path, [original.uid], { add: [flag] }).catch(() => {});
  }

  async function sendItem(item) {
    const { accounts, folders } = store.get();
    const account = accounts.find((a) => a.id === item.accountId);
    if (!account) {
      await removeFromOutbox(db, item.id);
      return;
    }
    const folderPath = (role) => folders.find((f) => f.accountId === account.id && f.role === role)?.path;

    try {
      const sentFolder = savesSentMail(account) ? undefined : folderPath('sent');
      await mail.send(account, item.data.outgoing, { sentFolder });
    } catch (error) {
      const retryAt = PERMANENT.has(error.code) ? HOLD : now() + retryDelay(item.attempts + 1);
      await recordFailure(db, item.id, { code: error.code ?? 'SERVER_ERROR', message: error.message }, retryAt);
      return;
    }

    await removeFromOutbox(db, item.id);
    await db.transaction((tx) =>
      recordContacts(tx, [...item.data.outgoing.to, ...item.data.outgoing.cc, ...item.data.outgoing.bcc], 'sent', now()),
    );
    await markOriginal(item, account);
    if (item.data.draftId) await deleteDraft(db, item.data.draftId);
    const drafts = folderPath('drafts');
    if (item.data.remoteDraftUid && drafts) {
      await mail.deleteMessages(account, drafts, [item.data.remoteDraftUid]).catch(() => {});
    }
  }

  async function process() {
    if (running) return running;
    running = (async () => {
      try {
        if (!store.get().online) return;
        for (const item of await listOutbox(db)) {
          if (item.sendAfter <= now()) await sendItem(item);
        }
      } finally {
        await refresh();
        running = null;
        arm();
      }
    })();
    return running;
  }

  return {
    process,
    refresh: async () => {
      await refresh();
      arm();
    },

    /** Queues a message; it goes out after the undo window. Returns the outbox ID. */
    async queue({ accountId, outgoing, replyOf = null, forwardOf = null, draftId = null, remoteDraftUid = null }) {
      const id = newId();
      await enqueue(db, {
        id,
        accountId,
        data: { outgoing, replyOf, forwardOf, draftId, remoteDraftUid },
        sendAfter: now() + UNDO_SEND_MS,
      });
      await refresh();
      arm();
      return id;
    },

    /** Takes a message back out of the outbox (undo, or edit). Returns it, or null if already sent. */
    async cancel(id) {
      const item = await getOutboxItem(db, id);
      if (!item) return null;
      await removeFromOutbox(db, id);
      await refresh();
      arm();
      return item;
    },

    async retry(id) {
      await rescheduleOutbox(db, id, now());
      await refresh();
      return process();
    },
  };
}
