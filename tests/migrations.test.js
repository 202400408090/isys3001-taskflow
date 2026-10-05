/**
 * Database migration tests.
 *
 * The migration runner is the component whose failure is hardest to recover
 * from, because a partially applied schema is not obviously broken. These tests
 * assert the properties that make recovery possible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, withTransaction, describeDatabaseError } from '../src/db/connection.js';
import { discoverMigrations, runMigrations, appliedMigrations, migrationStatus } from '../src/db/migrate.js';

function memoryDatabase() {
  return openDatabase({ path: ':memory:', isInMemory: true });
}

/** A throwaway directory holding a synthetic migration set. */
function withMigrationDir(files, run) {
  const directory = mkdtempSync(join(tmpdir(), 'taskflow-migrations-'));
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql, 'utf8');
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the repository migration set is discoverable and correctly named', () => {
  const migrations = discoverMigrations();

  assert.ok(migrations.length >= 1);
  for (const migration of migrations) {
    assert.match(migration.version, /^\d{4}$/);
    assert.match(migration.name, /^[a-z0-9_]+$/);
    assert.equal(migration.checksum.length, 16);
  }

  // Versions must be unique and ascending, which is what makes "apply in order"
  // well defined.
  const versions = migrations.map((migration) => migration.version);
  assert.deepEqual(versions, [...versions].sort());
  assert.equal(new Set(versions).size, versions.length);
});

test('a malformed migration filename is rejected instead of being silently skipped', () => {
  withMigrationDir({ 'init.sql': 'SELECT 1;' }, (directory) => {
    assert.throws(() => discoverMigrations(directory), /does not match/);
  });

  withMigrationDir({ '0001_Init.sql': 'SELECT 1;' }, (directory) => {
    assert.throws(() => discoverMigrations(directory), /does not match/);
  });
});

test('a duplicate migration version is rejected', () => {
  withMigrationDir(
    { '0001_first.sql': 'SELECT 1;', '0001_second.sql': 'SELECT 2;' },
    (directory) => {
      assert.throws(() => discoverMigrations(directory), /Duplicate migration version 0001/);
    },
  );
});

test('runMigrations applies every pending migration once and records the ledger', () => {
  const db = memoryDatabase();

  const first = runMigrations(db);
  assert.equal(first.applied.length, discoverMigrations().length);
  assert.equal(first.skipped.length, 0);

  const ledger = appliedMigrations(db);
  assert.equal(ledger.length, first.applied.length);
  assert.ok(ledger[0].applied_at, 'the ledger must timestamp each migration');
  assert.equal(typeof ledger[0].duration_ms, 'number');

  db.close();
});

test('runMigrations is idempotent: a second run applies nothing', () => {
  const db = memoryDatabase();

  runMigrations(db);
  const second = runMigrations(db);

  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, discoverMigrations().length);

  db.close();
});

test('editing an already applied migration is refused', () => {
  withMigrationDir({ '0001_first.sql': 'CREATE TABLE a (id INTEGER);' }, (directory) => {
    const db = memoryDatabase();
    runMigrations(db, { directory });

    // Simulate the file being edited after it was applied elsewhere.
    writeFileSync(join(directory, '0001_first.sql'), 'CREATE TABLE a (id INTEGER, extra TEXT);', 'utf8');

    assert.throws(() => runMigrations(db, { directory }), /modified after it was applied/);
    db.close();
  });
});

test('a failing migration rolls back completely and is not recorded', () => {
  withMigrationDir(
    {
      '0001_ok.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      '0002_broken.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY); THIS IS NOT SQL;',
    },
    (directory) => {
      const db = memoryDatabase();

      assert.throws(() => runMigrations(db, { directory }), /0002_broken failed/);

      // The good migration must be recorded and its table must exist.
      const applied = appliedMigrations(db).map((row) => row.version);
      assert.deepEqual(applied, ['0001']);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a'").get());

      // The broken migration must have left no trace at all.
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'").get(),
        undefined,
        'a rolled-back migration must not leave a partial table',
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version='0002'").get().c, 0);

      db.close();
    },
  );
});

test('migrationStatus reports pending, applied and modified states', () => {
  withMigrationDir(
    { '0001_first.sql': 'CREATE TABLE a (id INTEGER);', '0002_second.sql': 'CREATE TABLE b (id INTEGER);' },
    (directory) => {
      const db = memoryDatabase();

      assert.deepEqual(
        migrationStatus(db, { directory }).map((row) => row.state),
        ['pending', 'pending'],
      );

      runMigrations(db, { directory });
      assert.deepEqual(
        migrationStatus(db, { directory }).map((row) => row.state),
        ['applied', 'applied'],
      );

      writeFileSync(join(directory, '0001_first.sql'), 'CREATE TABLE a (id INTEGER, more TEXT);', 'utf8');
      assert.deepEqual(
        migrationStatus(db, { directory }).map((row) => row.state),
        ['modified', 'applied'],
      );

      db.close();
    },
  );
});

test('the initial schema enforces its CHECK constraints', () => {
  const db = memoryDatabase();
  runMigrations(db);

  const insert = db.prepare('INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)');

  assert.throws(() => insert.run('1', 'bad status', 'nearly-done'), /CHECK constraint failed/);
  assert.ok(insert.run('2', 'valid', 'todo'));

  // A completed task must carry a completion time.
  assert.throws(
    () => db.prepare("INSERT INTO tasks (id, title, status) VALUES ('3', 't', 'done')").run(),
    /CHECK constraint failed/,
  );

  // And an incomplete one must not carry one.
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO tasks (id, title, status, completed_at) VALUES ('4', 't', 'todo', '2026-01-01T00:00:00Z')")
        .run(),
    /CHECK constraint failed/,
  );

  db.close();
});

test('the initial schema constrains the due date format and the primary key', () => {
  const db = memoryDatabase();
  runMigrations(db);

  const insert = db.prepare('INSERT INTO tasks (id, title, due_date) VALUES (?, ?, ?)');
  assert.ok(insert.run('1', 'good', '2026-09-20'));
  assert.throws(() => insert.run('2', 'bad', '20/09/2026'), /CHECK constraint failed/);
  assert.throws(() => insert.run('1', 'duplicate id', null), /UNIQUE constraint failed/);

  db.close();
});

test('withTransaction rolls back every statement when the work throws', () => {
  const db = memoryDatabase();
  runMigrations(db);

  assert.throws(() => {
    withTransaction(db, () => {
      db.prepare("INSERT INTO tasks (id, title) VALUES ('tx1', 'inside transaction')").run();
      throw new Error('deliberate failure');
    });
  }, /deliberate failure/);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 0, 'the insert must have been rolled back');

  // And the connection must be usable afterwards.
  const committed = withTransaction(db, () => db.prepare("INSERT INTO tasks (id, title) VALUES ('tx2', 'ok')").run());
  assert.equal(committed.changes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 1);

  db.close();
});

test('describeDatabaseError turns a constraint violation into an actionable status', () => {
  const db = memoryDatabase();
  runMigrations(db);
  db.prepare("INSERT INTO tasks (id, title) VALUES ('1', 't')").run();

  let captured = null;
  try {
    db.prepare("INSERT INTO tasks (id, title) VALUES ('1', 't')").run();
  } catch (error) {
    captured = error;
  }

  const described = describeDatabaseError(captured);
  assert.equal(described.status, 409);
  assert.equal(described.code, 'CONFLICT');
  assert.equal(describeDatabaseError(new Error('not a database error')), null);

  db.close();
});
