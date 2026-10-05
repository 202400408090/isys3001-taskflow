#!/usr/bin/env node
/**
 * Validate every committed environment profile.
 *
 * WHY THIS IS A SCRIPT AND NOT A DOCUMENT
 * ---------------------------------------
 * The `.env.<environment>.example` files are the documented configuration
 * surface of the deployment, and they are the files a new environment is
 * created from. A typo in one of them - a misspelled variable name, a port
 * outside the valid range, a wildcard CORS origin in production - is therefore
 * a deployment defect that no test would otherwise catch, because the
 * application is never started with those files in the test suite.
 *
 * This command loads each profile through the real configuration loader with
 * the placeholder secrets replaced by obviously fake values, and reports
 * whether the profile would start.
 *
 * Usage:
 *   node scripts/validate-env.js
 *   node scripts/validate-env.js --verbose
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnvFile, buildConfig, ConfigurationError, VALID_ENVIRONMENTS, DEFAULTS } from '../src/config/index.js';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Stand-ins for values that must not appear in a committed file.
 *
 * These are deliberately recognisable as fakes, so that if one is ever found in
 * a real environment the mistake is obvious rather than plausible.
 */
const SECRET_STAND_INS = {
  API_KEY: 'validation-only-key-not-a-real-secret',
};

/**
 * A placeholder that names an injected value is expected in a committed
 * template. Anything else in a secret-valued variable is treated as a leak.
 */
const PLACEHOLDER_PATTERN = /^(|replace-.*|<.*>|your-.*|changeme.*|injected-.*)$/i;

const SECRET_VARIABLES = ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PRIVATE_KEY'];

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

/** Which variables are forwarded into a scenario, in the order layers apply. */
function loadProfile(environment) {
  const profileFile = join(projectRoot, `.env.${environment}.example`);
  const candidates = existsSync(profileFile) ? [profileFile] : [];

  // A developer's private `.env` is deliberately NOT read here. This command
  // validates what is *committed*, and folding a local file in would make the
  // result depend on the machine it ran on - which is the opposite of a check.
  //
  // The built-in defaults are the first layer, exactly as at runtime, so a
  // profile only has to describe what it changes.
  const forwarded = { ...DEFAULTS };
  const sources = [];

  for (const file of candidates) {
    const parsed = parseEnvFile(readFileSync(file, 'utf8'), forwarded);
    Object.assign(forwarded, parsed);
    sources.push(file.replace(projectRoot, '').replace(/^[\\/]/, ''));
  }

  // The profile's own NODE_ENV declaration is honoured rather than overridden.
  // A profile that declares the wrong environment is exactly the error this
  // check exists to find, so forcing the value here would hide it.
  forwarded.NODE_ENV = forwarded.NODE_ENV ?? environment;

  // A committed template points at a real database file. Validation must not
  // create one, and migrating it is not this command's job.
  forwarded.DATABASE_PATH = ':memory:';

  // Whether the committed profile itself supplies a real key, captured before
  // the stand-in below overwrites the value.
  const declaredKey = Boolean(
    forwarded.API_KEY && !PLACEHOLDER_PATTERN.test(String(forwarded.API_KEY).trim()),
  );

  // Apply the stand-in only where the template left the value as a placeholder,
  // so a genuinely set value is validated as written.
  let usedStandIn = false;
  for (const name of Object.keys(SECRET_STAND_INS)) {
    const value = forwarded[name];
    if (value === undefined || PLACEHOLDER_PATTERN.test(String(value).trim())) {
      usedStandIn = true;
      forwarded[name] = SECRET_STAND_INS[name];
    }
  }

  return { forwarded, sources, usedStandIn, declaredKey };
}

/** Find any secret-valued variable whose committed value is not a placeholder. */
function findLeakedSecrets(profileFile) {
  const path = join(projectRoot, profileFile);
  if (!existsSync(path)) return [];

  const leaks = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const name = trimmed.slice(0, separator).replace(/^export\s+/, '').trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');

    if (!SECRET_VARIABLES.some((candidate) => name.toUpperCase().includes(candidate))) continue;
    if (PLACEHOLDER_PATTERN.test(value)) continue;

    leaks.push({ file: profileFile, name, preview: `${value.slice(0, 4)}…` });
  }

  return leaks;
}

/* ========================================================================== */

const results = [];
const leaks = [];
let failures = 0;

for (const environment of VALID_ENVIRONMENTS) {
  const profileFile = `.env.${environment}.example`;
  const { forwarded, sources, usedStandIn, declaredKey } = loadProfile(environment);

  leaks.push(...findLeakedSecrets(profileFile));

  // The test environment is driven by explicit overrides in the suite, so it has
  // no committed profile. It is still validated, because a developer may start
  // the server with NODE_ENV=test.
  try {
    const config = buildConfig(forwarded);
    results.push({ environment, ok: true, sources, config, usedStandIn, declaredKey });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      results.push({ environment, ok: false, sources, problems: error.problems });
      failures += 1;
    } else {
      throw error;
    }
  }
}

process.stdout.write('\n  Environment profile validation\n');
process.stdout.write(`  ${'='.repeat(72)}\n`);

for (const result of results) {
  const label = `${result.environment.padEnd(12)} ${result.ok ? 'valid  ' : 'INVALID'}`;
  process.stdout.write(`\n  ${label}  ${result.sources.length ? result.sources.join(' -> ') : '(no committed profile; validated from defaults)'}\n`);

  if (result.ok) {
    const { config } = result;
    process.stdout.write(`      port                ${config.server.port}\n`);
    process.stdout.write(`      database            ${config.database.isInMemory ? ':memory:' : config.database.path}\n`);
    process.stdout.write(`      logging             ${config.logging.level} / ${config.logging.format}\n`);
    process.stdout.write(`      cors origins        ${config.security.corsOrigins.join(', ')}\n`);
    if (verbose) {
      process.stdout.write(`      rate limit          ${config.rateLimit.maxRequests} per ${config.rateLimit.windowMs}ms\n`);
      process.stdout.write(`      body limit          ${config.http.bodyLimit} bytes\n`);
      process.stdout.write(
        '      write auth          validated with a stand-in key' +
          `${result.usedStandIn && !result.declaredKey ? ' (the profile itself declares none)' : ''}\n`,
      );
    }
  } else {
    for (const problem of result.problems) process.stdout.write(`      - ${problem}\n`);
  }
}

if (leaks.length > 0) {
  process.stdout.write('\n  Secret-looking values found in committed files\n');
  process.stdout.write(`  ${'-'.repeat(72)}\n`);
  for (const leak of leaks) process.stdout.write(`    ${leak.file}: ${leak.name} = ${leak.preview}\n`);
  failures += leaks.length;
}

process.stdout.write(`\n  ${'='.repeat(72)}\n`);

if (failures > 0) {
  process.stdout.write(`  ${failures} problem(s) found. Fix them before deploying.\n\n`);
  process.exit(1);
}

process.stdout.write(`  ${results.length} profile(s) validated, no secret leaked into a committed file.\n\n`);
process.exit(0);
