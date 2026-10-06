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
  {
    version: 4,
    sql: `
      -- Compose (PLAN.md §4.8): local drafts, autosaved while editing and
      -- mirrored to the IMAP Drafts folder when the editor closes.
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        data_json TEXT NOT NULL,
        remote_uid INTEGER,
        updated_at INTEGER NOT NULL
      );

      -- Outbox (PLAN.md §4.1): messages wait here until sent, so sending
      -- works offline and can be undone for a few seconds.
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        data_json TEXT NOT NULL,
        send_after INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    /**
     * Full-text search (PLAN.md §4.6). FTS4 rather than FTS5 because the
     * browser build's sql.js only has FTS4; both work the same for this use.
     * If the module is missing, search falls back to LIKE (app_meta.search).
     * Statements run one at a time: the native plugin's script splitter
     * doesn't cope with trigger bodies.
     */
    async run(tx) {
      await tx.run('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)');
      const columns = 'subject, from_name, from_addr, to_json, body_text';
      const values = 'new.subject, new.from_name, new.from_addr, new.to_json, new.body_text';
      try {
        await tx.run(
          `CREATE VIRTUAL TABLE messages_fts USING fts4(content='messages', ${columns}, tokenize=unicode61 'remove_diacritics=2')`,
        );
      } catch {
        await tx.run("INSERT INTO app_meta (key, value) VALUES ('search', 'like')");
        return;
      }
      await tx.run(`CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (docid, ${columns}) VALUES (new.id, ${values}); END`);
      await tx.run(`CREATE TRIGGER messages_fts_before_update BEFORE UPDATE OF ${columns} ON messages BEGIN
        DELETE FROM messages_fts WHERE docid = old.id; END`);
      await tx.run(`CREATE TRIGGER messages_fts_after_update AFTER UPDATE OF ${columns} ON messages BEGIN
        INSERT INTO messages_fts (docid, ${columns}) VALUES (new.id, ${values}); END`);
      await tx.run(`CREATE TRIGGER messages_fts_delete BEFORE DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE docid = old.id; END`);
      await tx.run("INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')");
      await tx.run("INSERT INTO app_meta (key, value) VALUES ('search', 'fts4')");
    },
  },
  {
    version: 6,
    sql: `
      -- Calendar suggestions the user dismissed (PLAN.md §4.7), per message and day.
      CREATE TABLE dismissed_dates (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        day INTEGER NOT NULL,
        PRIMARY KEY (message_id, day)
      );
    `,
  },
  {
    version: 7,
    sql: `
      -- Conversation lists find each thread's newest message with this (repo-threads.js).
      CREATE INDEX messages_folder_thread_received ON messages (folder_id, thread_id, date_received);
    `,
  },
  {
    version: 8,
    sql: `
      -- Senders and domains whose mail goes straight to Trash (blocking.js).
      CREATE TABLE blocked_senders (
        kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
        value TEXT NOT NULL COLLATE NOCASE,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
      );
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
      if (migration.run) await migration.run(tx);
      else await tx.exec(migration.sql);
      await tx.run('INSERT INTO schema_version (version) VALUES (?)', [migration.version]);
    });
  }
  return migrations.at(-1)?.version ?? current;
}
