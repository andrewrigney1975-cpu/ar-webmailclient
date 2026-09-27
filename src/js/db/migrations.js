/**
 * Schema migrations, applied in order inside a transaction each. Never edit a
 * migration that has shipped; add a new one.
 */
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL,
        imap_security TEXT NOT NULL,
        imap_username TEXT NOT NULL,
        smtp_host TEXT,
        smtp_port INTEGER,
        smtp_security TEXT,
        smtp_username TEXT,
        accent_color TEXT NOT NULL,
        signature TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        sync_interval_minutes INTEGER NOT NULL DEFAULT 15,
        notify INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE folders (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        delimiter TEXT,
        role TEXT,
        attributes_json TEXT NOT NULL DEFAULT '[]',
        subscribed INTEGER NOT NULL DEFAULT 1,
        selectable INTEGER NOT NULL DEFAULT 1,
        uid_validity INTEGER,
        uid_next INTEGER,
        highest_mod_seq INTEGER,
        total_count INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_synced_at INTEGER,
        UNIQUE (account_id, path)
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        uid INTEGER NOT NULL,
        message_id TEXT,
        in_reply_to TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        thread_id TEXT,
        subject TEXT,
        from_name TEXT,
        from_addr TEXT,
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        reply_to_json TEXT NOT NULL DEFAULT '[]',
        date_sent INTEGER,
        date_received INTEGER,
        size INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        flags_json TEXT NOT NULL DEFAULT '[]',
        is_read INTEGER NOT NULL DEFAULT 0,
        is_flagged INTEGER NOT NULL DEFAULT 0,
        snippet TEXT,
        body_text TEXT,
        body_html TEXT,
        body_fetched_at INTEGER,
        UNIQUE (folder_id, uid)
      );

      CREATE INDEX messages_folder_received ON messages (folder_id, date_received DESC);
      CREATE INDEX messages_folder_sent ON messages (folder_id, date_sent DESC);
      CREATE INDEX messages_folder_size ON messages (folder_id, size);
      CREATE INDEX messages_folder_from ON messages (folder_id, from_addr);
      CREATE INDEX messages_received ON messages (date_received DESC);
      CREATE INDEX messages_message_id ON messages (message_id);
      CREATE INDEX messages_thread ON messages (thread_id);

      CREATE TABLE contacts (
        address TEXT PRIMARY KEY COLLATE NOCASE,
        name TEXT,
        times_sent_to INTEGER NOT NULL DEFAULT 0,
        times_received_from INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Senders whose remote images load automatically (PLAN.md §4.8).
      CREATE TABLE trusted_senders (
        address TEXT PRIMARY KEY COLLATE NOCASE,
        added_at INTEGER NOT NULL
      );

      -- Attachment list saved with the cached body, so reading offline shows it.
      ALTER TABLE messages ADD COLUMN attachments_json TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      -- Threading (PLAN.md §4.2): every Message-ID each message refers to
      -- (References and In-Reply-To), so replies can find each other in either order.
      CREATE TABLE message_refs (
        account_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        message_row_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX message_refs_ref ON message_refs (account_id, ref);
      CREATE INDEX message_refs_row ON message_refs (message_row_id);

      ALTER TABLE messages ADD COLUMN subject_norm TEXT;
      CREATE INDEX messages_account_message_id ON messages (account_id, message_id);
      CREATE INDEX messages_account_subject ON messages (account_id, subject_norm, date_sent);
      CREATE INDEX messages_folder_thread ON messages (folder_id, thread_id);
    `,
  },
];

export async function migrate(db, migrations = MIGRATIONS) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
  const row = await db.get('SELECT MAX(version) AS version FROM schema_version');
  const current = row?.version ?? 0;

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO schema_version (version) VALUES (?)', [migration.version]);
    });
  }
  return migrations.at(-1)?.version ?? current;
}
