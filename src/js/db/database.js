/**
 * Database access. One interface over two drivers:
 *   - Android: @capacitor-community/sqlite with SQLCipher encryption (driver-native.js)
 *   - Browser and tests: sql.js (driver-sqljs.js)
 *
 * All access goes through a lock, so a transaction never interleaves with
 * other statements on the single connection. Inside `transaction(fn)`, use the
 * `tx` argument rather than `db`, or the call waits on its own lock.
 */
import { migrate } from './migrations.js';

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}

/** SQLite has no booleans or undefined. */
function normalise(params = []) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (value === true) return 1;
    if (value === false) return 0;
    return value;
  });
}

function accessor(driver) {
  return {
    all: (sql, params) => driver.all(sql, normalise(params)),
    get: async (sql, params) => (await driver.all(sql, normalise(params)))[0] ?? null,
    run: (sql, params) => driver.run(sql, normalise(params)),
    exec: (sql) => driver.exec(sql),
  };
}

export function createDatabase(driver) {
  const lock = createLock();
  const direct = accessor(driver);

  return {
    all: (sql, params) => lock(() => direct.all(sql, params)),
    get: (sql, params) => lock(() => direct.get(sql, params)),
    run: (sql, params) => lock(() => direct.run(sql, params)),
    exec: (sql) => lock(() => direct.exec(sql)),

    transaction(fn) {
      return lock(async () => {
        await driver.begin();
        try {
          const result = await fn(direct);
          await driver.commit();
          return result;
        } catch (error) {
          await driver.rollback();
          throw error;
        }
      });
    },

    close: () => lock(() => driver.close()),
  };
}

export async function openDatabase({ driver } = {}) {
  let selected = driver;
  if (!selected) {
    const { Capacitor } = await import('@capacitor/core');
    selected = Capacitor.isNativePlatform()
      ? await (await import('./driver-native.js')).nativeDriver('despatch')
      : await (await import('./driver-sqljs.js')).browserDriver();
  }
  const db = createDatabase(selected);
  await db.exec('PRAGMA foreign_keys = ON;');
  await migrate(db);
  return db;
}
