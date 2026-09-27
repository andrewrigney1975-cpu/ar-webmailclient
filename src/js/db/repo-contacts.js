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
