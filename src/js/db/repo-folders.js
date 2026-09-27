/** Folders per account, and the sync state kept for each one. */

const ROLE_ORDER = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash'];

function toFolder(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    path: row.path,
    name: row.name,
    delimiter: row.delimiter,
    role: row.role,
    attributes: JSON.parse(row.attributes_json),
    subscribed: Boolean(row.subscribed),
    selectable: Boolean(row.selectable),
    uidValidity: row.uid_validity,
    uidNext: row.uid_next,
    highestModSeq: row.highest_mod_seq,
    totalCount: row.total_count,
    unreadCount: row.unread_count,
    lastSyncedAt: row.last_synced_at,
  };
}

/** Role folders first (Inbox, Drafts, Sent…), then the rest by path. */
export function compareFolders(a, b) {
  const rank = (folder) => {
    const index = ROLE_ORDER.indexOf(folder.role);
    return index === -1 ? ROLE_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
}

export async function listFolders(db, accountId) {
  const rows = accountId
    ? await db.all('SELECT * FROM folders WHERE account_id = ?', [accountId])
    : await db.all('SELECT * FROM folders');
  return rows.map(toFolder).sort(compareFolders);
}

export async function getFolder(db, folderId) {
  const row = await db.get('SELECT * FROM folders WHERE id = ?', [folderId]);
  return row && toFolder(row);
}

/**
 * Makes the local folder list match the server's: inserts new folders,
 * updates changed ones and deletes folders that are gone (with their messages).
 * Run inside a transaction.
 */
export async function replaceFolders(tx, accountId, remoteFolders) {
  const existing = new Map(
    (await tx.all('SELECT id, path FROM folders WHERE account_id = ?', [accountId])).map((r) => [r.path, r.id]),
  );

  for (const folder of remoteFolders) {
    const values = [
      folder.name,
      folder.delimiter,
      folder.role,
      JSON.stringify(folder.attributes ?? []),
      folder.subscribed,
      folder.selectable,
    ];
    if (existing.has(folder.path)) {
      await tx.run(
        `UPDATE folders SET name = ?, delimiter = ?, role = ?, attributes_json = ?, subscribed = ?, selectable = ?
         WHERE id = ?`,
        [...values, existing.get(folder.path)],
      );
      existing.delete(folder.path);
    } else {
      await tx.run(
        `INSERT INTO folders (name, delimiter, role, attributes_json, subscribed, selectable, account_id, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, accountId, folder.path],
      );
    }
  }

  for (const id of existing.values()) {
    await tx.run('DELETE FROM folders WHERE id = ?', [id]);
  }
}

export async function updateFolderSyncState(tx, folderId, state) {
  await tx.run(
    `UPDATE folders SET uid_validity = ?, uid_next = ?, highest_mod_seq = ?, total_count = ?, unread_count = ?,
       last_synced_at = ?
     WHERE id = ?`,
    [state.uidValidity, state.uidNext, state.highestModSeq, state.totalCount, state.unreadCount, state.lastSyncedAt, folderId],
  );
}

export async function adjustUnreadCount(db, folderId, delta) {
  await db.run('UPDATE folders SET unread_count = MAX(0, unread_count + ?) WHERE id = ?', [delta, folderId]);
}
