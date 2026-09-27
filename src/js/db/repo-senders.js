/** Senders the user allowed to show remote images. */

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
