/**
 * Message actions: read/unread, flag, move, archive, trash, delete forever,
 * and undo. Each works on any mix of messages (the Unified Inbox spans
 * accounts), grouped per account and folder for the server calls.
 *
 * Moves are optimistic: the cached row moves to the destination right away
 * with a placeholder UID, so lists update without waiting for the server. When
 * the server answers, the row gets its new UID (or is dropped for the
 * destination's next sync to fetch); if the call fails, the row goes back.
 */
import { MailError, MailErrorCode } from './bridge.js';
import { adjustUnreadCount, listFolders } from '../db/repo-folders.js';
import { deleteMessageIds, getMessages, relocate, setLocalFlags } from '../db/repo-messages.js';

export function createMessageActions({ db, mail, store }) {
  function lookup(message) {
    const { accounts, folders } = store.get();
    return {
      account: accounts.find((a) => a.id === message.accountId),
      folder: folders.find((f) => f.id === message.folderId),
    };
  }

  /** Groups messages by folder: [{ account, folder, messages }]. */
  function byFolder(messages) {
    const groups = new Map();
    for (const message of messages) {
      const { account, folder } = lookup(message);
      if (!account || !folder) continue;
      if (!groups.has(folder.id)) groups.set(folder.id, { account, folder, messages: [] });
      groups.get(folder.id).messages.push(message);
    }
    return [...groups.values()];
  }

  async function refresh() {
    store.set((state) => ({ dataVersion: state.dataVersion + 1 }));
    store.set({ folders: await listFolders(db) });
  }

  async function changeFlag(ids, flag, on) {
    const messages = (await getMessages(db, ids)).filter((m) => m.flags.includes(flag) !== on);
    if (messages.length === 0) return;

    const apply = async (enabled) => {
      for (const m of messages) {
        const flags = enabled ? [...m.flags.filter((f) => f !== flag), flag] : m.flags.filter((f) => f !== flag);
        await setLocalFlags(db, m.id, flags);
        if (flag === '\\Seen') await adjustUnreadCount(db, m.folderId, enabled ? -1 : 1);
      }
      await refresh();
    };

    await apply(on);
    try {
      for (const { account, folder, messages: group } of byFolder(messages)) {
        const change = on ? { add: [flag] } : { remove: [flag] };
        await mail.setFlags(account, folder.path, group.map((m) => m.uid), change);
      }
    } catch (error) {
      await apply(!on);
      throw error;
    }
  }

  /** Destination folder per message: a folder ID, or a role looked up in each message's own account. */
  function destinationFor(message, target) {
    const { folders } = store.get();
    if (typeof target === 'number') return folders.find((f) => f.id === target);
    return folders.find((f) => f.accountId === message.accountId && f.role === target);
  }

  /**
   * Moves messages. `target` is a folder ID or a role ('archive', 'trash').
   * Returns an undo token, or null if nothing moved.
   */
  async function move(ids, target) {
    const messages = await getMessages(db, ids);
    const plan = [];
    for (const message of messages) {
      const destination = destinationFor(message, target);
      if (!destination) {
        const name = typeof target === 'string' ? target : 'destination';
        throw new MailError(MailErrorCode.FOLDER_NOT_FOUND, `This account has no ${name} folder.`);
      }
      if (destination.id !== message.folderId) plan.push({ message, destination });
    }
    if (plan.length === 0) return null;

    await db.transaction(async (tx) => {
      for (const { message, destination } of plan) await relocate(tx, message.id, destination.id, -message.id);
    });
    await shiftUnread(plan, 1);
    await refresh();

    const moved = [];
    try {
      for (const { account, folder, messages: group } of byFolder(plan.map((p) => p.message))) {
        const steps = plan.filter((p) => group.includes(p.message));
        for (const destinationSteps of Map.groupBy(steps, (p) => p.destination.id).values()) {
          const destination = destinationSteps[0].destination;
          const uids = destinationSteps.map((p) => p.message.uid);
          const newUids = await mail.moveMessages(account, folder.path, uids, destination.path);
          destinationSteps.forEach((step, index) => moved.push({ ...step, newUid: newUids[index] ?? null }));
        }
      }
    } catch (error) {
      // Put back whatever the server didn't move.
      const done = new Set(moved.map((m) => m.message.id));
      const failed = plan.filter((p) => !done.has(p.message.id));
      await db.transaction(async (tx) => {
        for (const { message } of failed) await relocate(tx, message.id, message.folderId, message.uid);
      });
      await shiftUnread(failed, -1);
      await finalise(moved);
      await refresh();
      throw error;
    }

    await finalise(moved);
    await refresh();
    return {
      count: moved.length,
      undoable: moved.every((m) => m.newUid != null),
      moves: moved.map(({ message, newUid }) => ({ id: message.id, from: message.folderId, newUid })),
    };
  }

  async function finalise(moved) {
    await db.transaction(async (tx) => {
      for (const { message, destination, newUid } of moved) {
        // Without UIDPLUS the new UID is unknown: drop the row; the destination's sync fetches it.
        if (newUid == null) await deleteMessageIds(tx, [message.id]);
        else await relocate(tx, message.id, destination.id, newUid);
      }
    });
  }

  async function shiftUnread(steps, direction) {
    for (const { message, destination } of steps) {
      if (message.isRead) continue;
      await adjustUnreadCount(db, message.folderId, -direction);
      await adjustUnreadCount(db, destination.id, direction);
    }
  }

  /** Moves messages back to where they came from. */
  async function undo(token) {
    if (!token?.undoable) return;
    for (const { id, from } of token.moves) await move([id], from);
  }

  /** Permanently deletes messages. Only offered for Trash (and Junk). */
  async function deleteForever(ids) {
    const messages = await getMessages(db, ids);
    for (const { account, folder, messages: group } of byFolder(messages)) {
      await mail.deleteMessages(account, folder.path, group.map((m) => m.uid));
      await db.transaction((tx) => deleteMessageIds(tx, group.map((m) => m.id)));
      const unread = group.filter((m) => !m.isRead).length;
      if (unread) await adjustUnreadCount(db, folder.id, -unread);
    }
    await refresh();
  }

  return {
    markRead: (ids, read = true) => changeFlag(ids, '\\Seen', read),
    setFlagged: (ids, flagged = true) => changeFlag(ids, '\\Flagged', flagged),
    move,
    archive: (ids) => move(ids, 'archive'),
    trash: (ids) => move(ids, 'trash'),
    deleteForever,
    undo,
  };
}
