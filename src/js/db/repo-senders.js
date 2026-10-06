/** Senders the user trusts (remote images load automatically) or blocked (mail goes to Trash). */

export async function isTrustedSender(db, address) {
  if (!address) return false;
  return Boolean(await db.get('SELECT 1 AS yes FROM trusted_senders WHERE address = ?', [address]));
}

export async function trustSender(db, address) {
  await db.run('INSERT OR IGNORE INTO trusted_senders (address, added_at) VALUES (?, ?)', [
    address.toLowerCase(),
    Date.now(),
  ]);
}

/** Blocked senders ('address') and domains ('domain'): [{ kind, value }], newest first. */
export async function listBlocked(db) {
  return db.all('SELECT kind, value FROM blocked_senders ORDER BY added_at DESC, value');
}

export async function blockSender(db, kind, value) {
  await db.run('INSERT OR IGNORE INTO blocked_senders (kind, value, added_at) VALUES (?, ?, ?)', [
    kind,
    value.trim().toLowerCase(),
    Date.now(),
  ]);
}

export async function unblockSender(db, kind, value) {
  await db.run('DELETE FROM blocked_senders WHERE kind = ? AND value = ?', [kind, value.toLowerCase()]);
}

/**
 * Cached Inbox messages from blocked senders, in accounts that have a Trash to
 * move them to. A blocked domain covers its subdomains too.
 */
export async function blockedInboxMessageIds(db) {
  const rows = await db.all(
    `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE f.role = 'inbox' AND m.uid > 0
       AND EXISTS (SELECT 1 FROM folders t WHERE t.account_id = m.account_id AND t.role = 'trash')
       AND EXISTS (
         SELECT 1 FROM blocked_senders b
         WHERE (b.kind = 'address' AND m.from_addr = b.value)
            OR (b.kind = 'domain' AND (m.from_addr LIKE '%@' || b.value OR m.from_addr LIKE '%.' || b.value))
       )`,
  );
  return rows.map((r) => r.id);
}
