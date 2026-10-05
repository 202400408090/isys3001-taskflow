/**
 * Centralised configuration loader.
 *
 * CONFIGURATION MANAGEMENT PRINCIPLE
 * ----------------------------------
 * Configuration is *externalised* from code and *layered* by environment:
 *
 *   1. Built-in defaults          (safe values for local development)
 *   2. `.env`                     (shared baseline, committed as a template)
 *   3. `.env.<NODE_ENV>`          (environment profile, committed as a template)
 *   4. Real process environment   (how Docker, Compose and CI/CD inject values)
 *
 * Later layers win. Layer 4 winning over layers 2 and 3 is what makes the same
 * image promotable from staging to production without rebuilding it: the
 * artefact never changes, only the environment it is deployed into.
 *
 * The loader also *validates and normalises* in one place. If a value is
 * invalid the process fails fast at start-up rather than failing later at the
 * first request, which keeps configuration errors out of production.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, '..', '..');

export const VALID_ENVIRONMENTS = ['development', 'test', 'staging', 'production'];

/**
 * Safe built-in defaults - the first layer of the precedence chain.
 *
 * Exported so that tooling can validate a profile against the same baseline the
 * application uses, rather than duplicating the list and letting it drift.
 */
export const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '0.0.0.0',
  APP_NAME: 'TaskFlow',
  DATABASE_PATH: './data/taskflow.development.sqlite',
  API_KEY: '',
  CORS_ORIGINS: '*',
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'pretty',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_REQUESTS: '300',
  TRUSTED_PROXIES: '',
  BODY_LIMIT: '64kb',
  APP_VERSION: '0.0.0',
  GIT_COMMIT: 'unknown',
  BUILD_TIME: '',
};

export class ConfigurationError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

/**
 * Parse a dotenv-format file.
 * Supports `KEY=value`, `export KEY=value`, `#` comments, blank lines,
 * single/double quoted values and inline `${VAR}` interpolation.
 */
export function parseEnvFile(contents, base = {}) {
  const result = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).replace(/^export\s+/, '').trim();
    if (!key) continue;

    let value = line.slice(separator + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment: `PORT=3000 # comment`
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    // Interpolate ${VAR} against values resolved so far, then the base layer.
    value = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => result[name] ?? base[name] ?? '');

    if (value !== '') result[key] = value;
  }

  return result;
}

/**
 * Read and merge the configuration layers for a given environment.
 * Layer order (lowest to highest precedence):
 *   defaults -> .env -> .env.<NODE_ENV> -> process.env -> explicit overrides
 */
export function loadLayeredEnvironment({ env = process.env.NODE_ENV || 'development', root = PROJECT_ROOT, overrides = {} } = {}) {
  const files = [resolve(root, '.env'), resolve(root, `.env.${env}`)];
  const sources = [];
  let merged = { ...DEFAULTS };

  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, 'utf8'), merged);
    merged = { ...merged, ...parsed };
    sources.push(file);
  }

  // The real process environment is applied last so that container and CI
  // injection always beats a file that happened to be baked into the image.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }

  merged = { ...merged, ...overrides };
  merged.NODE_ENV = env;

  return { values: merged, sources };
}

function toInteger(raw, { name, min, max, problems }) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== String(raw).trim()) {
    problems.push(`${name} must be an integer (received "${raw}")`);
    return min;
  }
  if (parsed < min || parsed > max) {
    problems.push(`${name} must be between ${min} and ${max} (received ${parsed})`);
    return min;
  }
  return parsed;
}

/**
 * Convert a size string such as `64kb` or `1mb` to bytes.
 */
export function parseSize(raw) {
  const match = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(String(raw).trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
  return amount * multiplier;
}

/**
 * Validate and normalise raw values into the typed configuration object that
 * the rest of the application consumes.
 */
export function buildConfig(values, { sources = [] } = {}) {
  const problems = [];

  const env = String(values.NODE_ENV || 'development').toLowerCase();
  if (!VALID_ENVIRONMENTS.includes(env)) {
    problems.push(`NODE_ENV must be one of ${VALID_ENVIRONMENTS.join(', ')} (received "${values.NODE_ENV}")`);
  }

  const isProductionLike = env === 'staging' || env === 'production';

  const port = toInteger(values.PORT, { name: 'PORT', min: 0, max: 65535, problems });

  const logLevel = String(values.LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of debug, info, warn, error (received "${values.LOG_LEVEL}")`);
  }

  const logFormat = String(values.LOG_FORMAT || (isProductionLike ? 'json' : 'pretty')).toLowerCase();
  if (!['pretty', 'json'].includes(logFormat)) {
    problems.push(`LOG_FORMAT must be either pretty or json (received "${values.LOG_FORMAT}")`);
  }

  const bodyLimit = parseSize(values.BODY_LIMIT);
  if (bodyLimit === null) {
    problems.push(`BODY_LIMIT must look like 16kb, 1mb, ... (received "${values.BODY_LIMIT}")`);
  }

  const apiKey = String(values.API_KEY ?? '').trim();
  if (isProductionLike && apiKey.length < 16) {
    problems.push(
      `API_KEY must be set to at least 16 characters in the ${env} environment ` +
        '(write operations would otherwise be unauthenticated)',
    );
  }

  const corsOrigins = String(values.CORS_ORIGINS ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (isProductionLike && corsOrigins.includes('*')) {
    problems.push(`CORS_ORIGINS must not contain "*" in the ${env} environment`);
  }

  /**
   * Addresses permitted to set `X-Forwarded-For`.
   *
   * Empty by default, which means the header is ignored. That default is the
   * safe one: honouring a forwarded address from an arbitrary peer lets any
   * client choose its own rate-limit bucket by changing a single header, which
   * is worse than the shared budget it appears to fix.
   */
  const trustedProxies = String(values.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const databasePath = String(values.DATABASE_PATH || DEFAULTS.DATABASE_PATH);

  if (problems.length > 0) {
    throw new ConfigurationError(
      `Invalid configuration for NODE_ENV=${env}:\n  - ${problems.join('\n  - ')}`,
      problems,
    );
  }

  return Object.freeze({
    env,
    isProductionLike,
    isTest: env === 'test',
    appName: String(values.APP_NAME || DEFAULTS.APP_NAME),
    version: String(values.APP_VERSION || DEFAULTS.APP_VERSION),
    gitCommit: String(values.GIT_COMMIT || DEFAULTS.GIT_COMMIT),
    buildTime: String(values.BUILD_TIME || ''),
    server: Object.freeze({
      port,
      host: String(values.HOST || DEFAULTS.HOST),
    }),
    database: Object.freeze({
      path: databasePath,
      isInMemory: databasePath === ':memory:',
    }),
    security: Object.freeze({
      apiKey,
      writeAuthEnabled: apiKey.length > 0,
      corsOrigins: Object.freeze(corsOrigins),
    }),
    logging: Object.freeze({ level: logLevel, format: logFormat }),
    rateLimit: Object.freeze({
      windowMs: toInteger(values.RATE_LIMIT_WINDOW_MS, {
        name: 'RATE_LIMIT_WINDOW_MS',
        min: 1000,
        max: 3_600_000,
        problems,
      }),
      maxRequests: toInteger(values.RATE_LIMIT_MAX_REQUESTS, {
        name: 'RATE_LIMIT_MAX_REQUESTS',
        min: 1,
        max: 1_000_000,
        problems,
      }),
      trustedProxies: Object.freeze(trustedProxies),
    }),
    http: Object.freeze({ bodyLimit }),
    meta: Object.freeze({ sources: Object.freeze([...sources]) }),
  });
}

/**
 * Convenience entry point used by the application: read the layers, build the
 * typed config, and report which files contributed.
 */
export function loadConfig(options = {}) {
  const { values, sources } = loadLayeredEnvironment(options);
  const config = buildConfig(values, { sources });

  if (!config.isTest) {
    const logger = createLogger({ level: config.logging.level, format: config.logging.format, name: 'config' });
    logger.info('configuration loaded', {
      env: config.env,
      version: config.version,
      commit: config.gitCommit,
      files: sources.map((file) => file.replace(`${PROJECT_ROOT}\\`, '').replace(`${PROJECT_ROOT}/`, '')),
      writeAuthEnabled: config.security.writeAuthEnabled,
      database: config.database.isInMemory ? '(in-memory)' : config.database.path,
    });
  }

  return config;
}

/**
 * A configuration summary safe to expose over HTTP (`GET /api/v1/meta`).
 * Secrets are reduced to booleans, never echoed.
 */
export function describeConfig(config) {
  return {
    environment: config.env,
    application: { name: config.appName, version: config.version },
    revision: { commit: config.gitCommit, builtAt: config.buildTime || null },
    features: { writeAuthentication: config.security.writeAuthEnabled },
    runtime: { node: process.version, platform: process.platform, pid: process.pid },
  };
}
