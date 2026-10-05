#!/usr/bin/env node
/**
 * Apply pending database migrations.
 *
 * Usage:
 *   npm run migrate                  # apply every pending migration
 *   npm run migrate:status           # report applied / pending / modified
 *   node scripts/migrate.js --dry-run
 *
 * The server also migrates at start-up, so this command exists for the
 * deployment pipeline, where bringing the schema up to date is a distinct,
 * observable stage that must succeed before the new revision receives traffic.
 */

import { runMigrations, migrationStatus, discoverMigrations } from '../src/db/migrate.js';
import { bootstrap, heading, row } from './lib/environment.js';

const help = `
Apply pending database migrations.

Usage: node scripts/migrate.js [options]

Options:
  --status     Report the state of every migration without applying anything
  --dry-run    List the migrations that would be applied, then exit
  --help, -h   Show this message

Environment:
  DATABASE_PATH   Database file to migrate (default: per NODE_ENV profile)
  NODE_ENV        Selects the configuration profile

Exit status:
  0  the schema is up to date
  1  configuration was invalid, a migration failed, or a migration was edited
`;

const { config, logger, db, helpRequested } = bootstrap({ name: 'migrate' });

if (helpRequested) {
  process.stdout.write(help);
  process.exit(0);
}

const target = config.database.isInMemory ? ':memory:' : config.database.path;
const statusOnly = process.argv.includes('--status');
const dryRun = process.argv.includes('--dry-run');

heading('Database migration');
row('environment', config.env);
row('database', target);
row('migrations', discoverMigrations().length);

if (statusOnly) {
  const rows = migrationStatus(db);
  process.stdout.write('\n  state      version  name\n');
  process.stdout.write(`  ${'-'.repeat(58)}\n`);
  for (const entry of rows) {
    const marker = { applied: 'applied  ', pending: 'pending  ', modified: 'MODIFIED ' }[entry.state];
    process.stdout.write(`  ${marker} ${entry.version}     ${entry.name}\n`);
  }

  const modified = rows.filter((entry) => entry.state === 'modified');
  if (modified.length > 0) {
    process.stdout.write(
      '\n  Migration files marked MODIFIED have already been applied and must not be\n' +
        '  edited. Revert the file and add a new migration instead.\n',
    );
  }
  process.stdout.write('\n');
  db.close();
  process.exit(modified.length > 0 ? 1 : 0);
}

if (dryRun) {
  const applied = new Set(migrationStatus(db).filter((entry) => entry.state === 'applied').map((entry) => entry.version));
  const pending = discoverMigrations().filter((migration) => !applied.has(migration.version));

  if (pending.length === 0) process.stdout.write('\n  nothing to apply; the schema is current\n\n');
  else {
    process.stdout.write('\n  would apply:\n');
    for (const migration of pending) process.stdout.write(`    ${migration.version}_${migration.name}\n`);
    process.stdout.write('\n');
  }
  db.close();
  process.exit(0);
}

try {
  const result = runMigrations(db, { logger });

  process.stdout.write('\n');
  if (result.applied.length === 0) {
    row('result', `already current (${result.skipped.length} applied previously)`);
  } else {
    row('applied', result.applied.length);
    for (const version of result.applied) process.stdout.write(`    + ${version}\n`);
  }
  process.stdout.write('\n  Schema is up to date.\n\n');
  db.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(`\n  Migration failed: ${error.message}\n\n`);
  db.close();
  process.exit(1);
}
