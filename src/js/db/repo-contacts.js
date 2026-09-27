/**
 * Addresses seen in mail, with counts used to rank autocomplete suggestions
 * (PLAN.md §4.3). Filled in by sync as new messages arrive.
 */

/** Run inside a transaction. `direction` is 'received' (sender) or 'sent' (recipient). */
export async function recordContacts(tx, addresses, direction, seenAt) {
  const column = direction === 'sent' ? 'times_sent_to' : 'times_received_from';
  for (const { name, address } of addresses) {
    if (!address) continue;
    await tx.run(
      `INSERT INTO contacts (address, name, ${column}, last_seen_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (address) DO UPDATE SET
         name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
         ${column} = contacts.${column} + 1,
         last_seen_at = MAX(COALESCE(contacts.last_seen_at, 0), excluded.last_seen_at)`,
      [address.toLowerCase(), name || null, seenAt ?? Date.now()],
    );
  }
}

export async function getContact(db, address) {
  return db.get('SELECT * FROM contacts WHERE address = ?', [address]);
}

/**
 * Contacts matching what's typed (address, or the start of any word of the
 * name), ranked for autocomplete.
 */
export async function searchContacts(db, query, { limit = 8, rank } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // "!" escapes LIKE wildcards typed by the user.
  const like = `${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
  const rows = await db.all(
    `SELECT * FROM contacts
     WHERE address LIKE ? ESCAPE '!' OR LOWER(name) LIKE ? ESCAPE '!' OR LOWER(name) LIKE ? ESCAPE '!'
     LIMIT 50`,
    [like, like, `% ${like}`],
  );
  return (rank ? rank(rows, q) : rows).slice(0, limit).map((c) => ({ name: c.name, address: c.address }));
}
