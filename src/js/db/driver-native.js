/**
 * Android driver: @capacitor-community/sqlite with SQLCipher. The encryption
 * passphrase is generated once and handed to the plugin, which keeps it in
 * Android's encrypted storage; JS never stores it.
 */
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

function randomPassphrase() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function nativeDriver(name) {
  const sqlite = new SQLiteConnection(CapacitorSQLite);

  if (!(await sqlite.isSecretStored()).result) {
    await sqlite.setEncryptionSecret(randomPassphrase());
  }

  const consistent = (await sqlite.checkConnectionsConsistency()).result;
  const exists = (await sqlite.isConnection(name, false)).result;
  const connection =
    consistent && exists
      ? await sqlite.retrieveConnection(name, false)
      : await sqlite.createConnection(name, true, 'secret', 1, false);
  await connection.open();

  return {
    async all(sql, params) {
      return (await connection.query(sql, params)).values ?? [];
    },
    async run(sql, params) {
      // transaction=false: our own transaction() wraps statements where needed.
      const result = await connection.run(sql, params, false);
      return { changes: result.changes?.changes ?? 0, lastId: result.changes?.lastId ?? null };
    },
    async exec(sql) {
      await connection.execute(sql, false);
    },
    begin: () => connection.beginTransaction(),
    commit: () => connection.commitTransaction(),
    rollback: () => connection.rollbackTransaction(),
    async close() {
      await sqlite.closeConnection(name, false);
    },
  };
}
