/**
 * SQLite connection management.
 *
 * The application never imports `node:sqlite` outside this module and
 * `src/db/migrate.js`, so the choice of store is confined to two files. See
 * docs/adr/0005-sqlite-via-node-builtin.md.
 *
 * Configuration is injected, never read from the environment here: the caller
 * passes the validated config object.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Set once per process so repeated calls do not open extra handles. */
let sharedConnection = null;
let sharedPath = null;

/**
 * Apply the connection-level settings that make SQLite behave correctly for a
 * concurrent web workload rather than for a single-user desktop session.
 */
function applyPragmas(db, { isInMemory }) {
  // WAL lets readers proceed while a writer holds the write lock, which is the
  // difference between a responsive API and one that blocks on every write.
  // An in-memory database has no journal file, so the mode is left alone.
  if (!isInMemory) db.exec('PRAGMA journal_mode = WAL;');

  // Enforce declared foreign keys. SQLite disables them by default, so without
  // this line a dangling reference would be accepted silently.
  db.exec('PRAGMA foreign_keys = ON;');

  // Trade a small amount of durability on power loss for far fewer fsyncs.
  // NORMAL is the documented recommendation when WAL is enabled.
  if (!isInMemory) db.exec('PRAGMA synchronous = NORMAL;');

  // Give a writer up to five seconds to acquire the lock before failing, which
  // absorbs brief contention instead of surfacing SQLITE_BUSY to a client.
  db.exec('PRAGMA busy_timeout = 5000;');
}

/**
 * Open a connection to the configured database.
 *
 * @param {{ path: string, isInMemory: boolean }} databaseConfig validated
 *        `config.database` slice.
 * @param {{ logger?: object }} [options]
 */
export function openDatabase(databaseConfig, { logger } = {}) {
  const { path, isInMemory } = databaseConfig;

  let target = path;
  if (!isInMemory) {
    // `:memory:` needs no directory, but a file path does, and the data
    // directory is git-ignored so it will not exist on a fresh clone.
    const absolute = resolve(process.cwd(), path);
    mkdirSync(dirname(absolute), { recursive: true });
    target = absolute;
  }

  const db = new DatabaseSync(target);
  applyPragmas(db, { isInMemory });

  logger?.debug('database connection opened', {
    target: isInMemory ? ':memory:' : target,
    journalMode: isInMemory ? 'memory' : 'wal',
  });

  return db;
}

/**
 * Lazily open (and cache) the process-wide connection.
 */
export function getDatabase(databaseConfig, options = {}) {
  const key = databaseConfig.isInMemory ? ':memory:' : resolve(process.cwd(), databaseConfig.path);

  if (sharedConnection && sharedPath === key) return sharedConnection;

  if (sharedConnection) closeDatabase({ logger: options.logger });

  sharedConnection = openDatabase(databaseConfig, options);
  sharedPath = key;

  return sharedConnection;
}

/** Close the cached connection, if one is open. */
export function closeDatabase({ logger } = {}) {
  if (!sharedConnection) return false;
  try {
    sharedConnection.close();
    logger?.debug('database connection closed', { target: sharedPath });
  } finally {
    sharedConnection = null;
    sharedPath = null;
  }
  return true;
}

/**
 * Run `work` inside a transaction, rolling back if it throws.
 *
 * `BEGIN IMMEDIATE` takes the write lock at the start rather than on first
 * write, which turns a late `SQLITE_BUSY` into a predictable failure at the
 * beginning of the unit of work.
 */
export function withTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback failure means the transaction was already resolved; the
      // original error is the useful one, so it is re-thrown below.
    }
    throw error;
  }
}

/**
 * Translate a raw SQLite error into an HTTP-friendly shape.
 * Keeps driver-specific error codes out of the route handlers.
 */
export function describeDatabaseError(error) {
  const message = String(error?.message ?? '');
  if (error?.code !== 'ERR_SQLITE_ERROR') return null;
  if (message.includes('UNIQUE constraint failed')) {
    return { status: 409, code: 'CONFLICT', detail: 'A record with that identifier already exists.' };
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return { status: 409, code: 'CONFLICT', detail: 'A referenced record does not exist.' };
  }
  if (message.includes('CHECK constraint failed')) {
    return { status: 422, code: 'UNPROCESSABLE_ENTITY', detail: 'A value violates a database constraint.' };
  }
  return { status: 500, code: 'DATABASE_ERROR', detail: 'The database rejected the operation.' };
}
