/**
 * Forward-only database migration runner.
 *
 * WHY MIGRATIONS ARE VERSION CONTROLLED
 * -------------------------------------
 * The database schema is a software artefact that changes over time, so its
 * changes belong in the same history as the code that depends on them. A
 * migration file is applied exactly once, in filename order, and the ledger
 * table records what has run. This makes the schema of any environment
 * reproducible from the repository alone.
 *
 * Design rules:
 *   * Forward only. A migration that has been applied to a shared environment
 *     is never edited; a mistake is corrected by a new migration.
 *   * One transaction per migration, so a failure leaves the ledger and the
 *     schema consistent with each other.
 *   * The ledger row is written inside the same transaction as the schema
 *     change. A crash therefore cannot record a migration that did not run, nor
 *     run one that is not recorded.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Name pattern a migration file must satisfy: NNNN_description.sql */
const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    checksum    TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    duration_ms INTEGER NOT NULL DEFAULT 0
  );
`;

/**
 * Resolve a stable checksum for a migration file, so that an edit to an
 * already-applied migration can be detected and refused.
 */
function checksum(contents) {
  // A small non-cryptographic digest is sufficient: this detects accidental
  // edits, it is not a security boundary.
  let hash = 0n;
  const prime = 1099511628211n;
  const offset = 14695981039346656037n;
  hash = offset;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= BigInt(contents.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Read every migration file from disk, validated and in order. */
export function discoverMigrations(directory = MIGRATIONS_DIR) {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const migrations = [];
  const seen = new Set();

  for (const file of files) {
    const match = MIGRATION_PATTERN.exec(file);
    if (!match) {
      throw new Error(
        `Migration filename "${file}" does not match NNNN_snake_case_description.sql`,
      );
    }

    const [, version, name] = match;
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version} (at ${file})`);
    }
    seen.add(version);

    const sql = readFileSync(join(directory, file), 'utf8');
    migrations.push({ version, name, file, sql, checksum: checksum(sql) });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/** Ensure the ledger table exists. */
export function ensureLedger(db) {
  db.exec(LEDGER_TABLE);
}

/** Return the ledger contents, oldest first. */
export function appliedMigrations(db) {
  ensureLedger(db);
  return db.prepare('SELECT version, name, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version').all();
}

/**
 * Apply every pending migration.
 *
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(db, { directory = MIGRATIONS_DIR, logger } = {}) {
  ensureLedger(db);

  const migrations = discoverMigrations(directory);
  const ledger = new Map(appliedMigrations(db).map((row) => [row.version, row]));

  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    const recorded = ledger.get(migration.version);

    if (recorded) {
      // An applied migration must never change: other environments have already
      // executed the old text, so editing it would silently diverge the schemas.
      if (recorded.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version}_${migration.name} has been modified after it was applied. ` +
            'Create a new migration instead of editing an applied one.',
        );
      }
      skipped.push(migration.version);
      continue;
    }

    const startedAt = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      const record = db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES (?, ?, ?, ?)',
      );
      record.run(migration.version, migration.name, migration.checksum, Date.now() - startedAt);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Leave the original failure to surface below.
      }
      throw new Error(`Migration ${migration.version}_${migration.name} failed: ${error.message}`, {
        cause: error,
      });
    }

    applied.push(migration.version);
    logger?.info('migration applied', {
      version: migration.version,
      name: migration.name,
      durationMs: Date.now() - startedAt,
    });
  }

  return { applied, skipped };
}

/** Human-readable migration status, used by `npm run migrate:status`. */
export function migrationStatus(db, { directory = MIGRATIONS_DIR } = {}) {
  const migrations = discoverMigrations(directory);
  const ledger = new Map(appliedMigrations(db).map((row) => [row.version, row]));

  return migrations.map((migration) => {
    const recorded = ledger.get(migration.version);
    let state = 'pending';
    if (recorded && recorded.checksum === migration.checksum) state = 'applied';
    else if (recorded) state = 'modified';
    return {
      version: migration.version,
      name: migration.name,
      state,
      appliedAt: recorded?.applied_at ?? null,
      durationMs: recorded?.duration_ms ?? null,
    };
  });
}
