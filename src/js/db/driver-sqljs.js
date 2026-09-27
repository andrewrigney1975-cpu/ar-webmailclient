/**
 * sql.js driver for the browser build and tests. In the browser the database
 * is kept in IndexedDB between reloads; this build is for development only,
 * so it is not encrypted.
 */
import initSqlJs from 'sql.js';

/**
 * @param {object} options
 * @param {(bytes: Uint8Array) => void} [options.persist]  called with a snapshot after changes (debounced)
 */
export async function sqlJsDriver({ locateFile, data, persist = null, persistDelayMs = 500 } = {}) {
  const SQL = await initSqlJs(locateFile ? { locateFile } : {});
  const db = new SQL.Database(data);
  let inTransaction = false;
  let timer = null;

  function save() {
    // A transaction may be waiting on async work between statements; never snapshot mid-way.
    if (inTransaction) {
      timer = setTimeout(save, persistDelayMs);
      return;
    }
    timer = null;
    const bytes = db.export();
    // export() closes and reopens the database, which resets connection settings.
    db.exec('PRAGMA foreign_keys = ON;');
    persist(bytes);
  }

  const changed = () => {
    if (!persist || inTransaction) return;
    clearTimeout(timer);
    timer = setTimeout(save, persistDelayMs);
  };

  return {
    async all(sql, params) {
      const statement = db.prepare(sql);
      try {
        statement.bind(params);
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally {
        statement.free();
      }
    },
    async run(sql, params) {
      db.run(sql, params);
      const changes = db.getRowsModified();
      const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      changed();
      return { changes, lastId };
    },
    async exec(sql) {
      db.exec(sql);
      changed();
    },
    async begin() {
      db.exec('BEGIN');
      inTransaction = true;
    },
    async commit() {
      db.exec('COMMIT');
      inTransaction = false;
      changed();
    },
    async rollback() {
      db.exec('ROLLBACK');
      inTransaction = false;
    },
    async close() {
      clearTimeout(timer);
      db.close();
    },
    /** Test hook: writes any pending snapshot now. */
    flush() {
      if (timer) {
        clearTimeout(timer);
        save();
      }
    },
  };
}

// --- Browser persistence ---------------------------------------------------------------------

const IDB_NAME = 'despatch-dev';
const IDB_STORE = 'files';
const IDB_KEY = 'despatch.sqlite';

function idb(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = action(open.result.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

export async function browserDriver() {
  const { default: wasmUrl } = await import('sql.js/dist/sql-wasm.wasm?url');
  let data;
  try {
    data = await idb('readonly', (store) => store.get(IDB_KEY));
  } catch {
    data = undefined;
  }

  return sqlJsDriver({
    locateFile: () => wasmUrl,
    data,
    persist(bytes) {
      idb('readwrite', (store) => store.put(bytes, IDB_KEY)).catch(() => {});
    },
  });
}
