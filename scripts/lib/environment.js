/**
 * Shared start-up for operational scripts.
 *
 * `scripts/` commands run outside the server process but need the same
 * configuration and the same logger, otherwise a script could connect to a
 * different database than the server it is meant to maintain. Centralising the
 * bootstrap here is what guarantees they agree.
 */

import { loadConfig, ConfigurationError } from '../../src/config/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { openDatabase } from '../../src/db/connection.js';

/**
 * Load configuration and open a database connection.
 *
 * Any attempt to use `--help` short-circuits this: a usage message must not
 * require a valid database or a complete environment.
 */
export function bootstrap({ name, requireDatabase = true } = {}) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    return { helpRequested: true };
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`\nConfiguration error\n${'-'.repeat(72)}\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({
    level: process.env.SCRIPT_LOG_LEVEL ?? config.logging.level,
    format: config.logging.format,
    name,
  });

  const db = requireDatabase ? openDatabase(config.database, { logger }) : null;

  return { config, logger, db, helpRequested: false };
}

/** Print a heading so a script's output is readable in a CI log. */
export function heading(title) {
  process.stdout.write(`\n${title}\n${'='.repeat(title.length)}\n`);
}

/** Print a two-column row. */
export function row(label, value) {
  process.stdout.write(`  ${String(label).padEnd(22)} ${value}\n`);
}
