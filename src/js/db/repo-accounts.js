/** Accounts: connection settings and per-account preferences. Passwords are not stored here. */

function toAccount(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    imap: {
      host: row.imap_host,
      port: row.imap_port,
      security: row.imap_security,
      username: row.imap_username,
    },
    smtp: row.smtp_host
      ? { host: row.smtp_host, port: row.smtp_port, security: row.smtp_security, username: row.smtp_username }
      : null,
    accentColor: row.accent_color,
    signature: row.signature,
    sortOrder: row.sort_order,
    syncIntervalMinutes: row.sync_interval_minutes,
    notify: Boolean(row.notify),
    createdAt: row.created_at,
  };
}

export async function listAccounts(db) {
  const rows = await db.all('SELECT * FROM accounts ORDER BY sort_order, created_at');
  return rows.map(toAccount);
}

export async function insertAccount(db, account) {
  const { max } = (await db.get('SELECT COALESCE(MAX(sort_order), -1) AS max FROM accounts')) ?? { max: -1 };
  await db.run(
    `INSERT INTO accounts (
      id, email, display_name,
      imap_host, imap_port, imap_security, imap_username,
      smtp_host, smtp_port, smtp_security, smtp_username,
      accent_color, signature, sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      account.id,
      account.email,
      account.displayName,
      account.imap.host,
      account.imap.port,
      account.imap.security,
      account.imap.username,
      account.smtp?.host,
      account.smtp?.port,
      account.smtp?.security,
      account.smtp?.username,
      account.accentColor,
      account.signature,
      max + 1,
      account.createdAt ?? Date.now(),
    ],
  );
}

export async function deleteAccount(db, accountId) {
  // Folders and messages go with it (ON DELETE CASCADE).
  await db.run('DELETE FROM accounts WHERE id = ?', [accountId]);
}
