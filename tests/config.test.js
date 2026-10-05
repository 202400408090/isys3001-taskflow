/**
 * Unit tests for the layered configuration loader.
 *
 * These tests are the executable specification of the configuration
 * management rules described in docs/adr/0002.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConfig,
  parseEnvFile,
  parseSize,
  ConfigurationError,
  VALID_ENVIRONMENTS,
} from '../src/config/index.js';

/** A complete, valid set of raw values used as the baseline for each case. */
const validRaw = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '0.0.0.0',
  APP_NAME: 'TaskFlow',
  DATABASE_PATH: './data/test.sqlite',
  API_KEY: '',
  CORS_ORIGINS: '*',
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'pretty',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_REQUESTS: '300',
  BODY_LIMIT: '64kb',
  APP_VERSION: '1.0.0',
  GIT_COMMIT: 'abc1234',
  BUILD_TIME: '',
};

test('parseEnvFile reads keys, ignores comments and blanks', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'PORT=3000',
      'export HOST=127.0.0.1',
      'APP_NAME="Task Flow"',
      "QUOTED='single'",
      'TRAILING=value # inline comment',
      'NOT_A_PAIR',
    ].join('\n'),
  );

  assert.equal(parsed.PORT, '3000');
  assert.equal(parsed.HOST, '127.0.0.1');
  assert.equal(parsed.APP_NAME, 'Task Flow');
  assert.equal(parsed.QUOTED, 'single');
  assert.equal(parsed.TRAILING, 'value');
  assert.equal(parsed.NOT_A_PAIR, undefined);
});

test('parseEnvFile interpolates values from the file and the base layer', () => {
  const parsed = parseEnvFile(
    ['NAME=taskflow', 'DATABASE_PATH=./data/${NAME}.sqlite', 'FROM_BASE=${INHERITED}'].join('\n'),
    { INHERITED: 'base-value' },
  );

  assert.equal(parsed.DATABASE_PATH, './data/taskflow.sqlite');
  assert.equal(parsed.FROM_BASE, 'base-value');
});

test('parseEnvFile lets an empty value fall back to the previous layer', () => {
  const parsed = parseEnvFile('API_KEY=', { API_KEY: 'from-base' });
  assert.equal(parsed.API_KEY, undefined, 'an empty assignment must not overwrite a lower layer');
});

test('parseSize converts human-readable sizes to bytes', () => {
  assert.equal(parseSize('64kb'), 65536);
  assert.equal(parseSize('1mb'), 1048576);
  assert.equal(parseSize('512'), 512);
  assert.equal(parseSize('2 gb'), 2147483648);
  assert.equal(parseSize('nonsense'), null);
});

test('buildConfig normalises raw strings into typed values', () => {
  const config = buildConfig(validRaw);

  assert.equal(config.env, 'development');
  assert.equal(config.server.port, 3000);
  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.rateLimit.windowMs, 60000);
  assert.equal(config.rateLimit.maxRequests, 300);
  assert.equal(config.http.bodyLimit, 65536);
  assert.deepEqual(config.security.corsOrigins, ['*']);
  assert.equal(config.security.writeAuthEnabled, false);
  assert.equal(Object.isFrozen(config), true);
});

test('buildConfig enables write authentication whenever an API key is present', () => {
  const config = buildConfig({ ...validRaw, API_KEY: 'a-development-key' });
  assert.equal(config.security.writeAuthEnabled, true);
});

test('buildConfig splits a comma-separated CORS allow list', () => {
  const config = buildConfig({
    ...validRaw,
    NODE_ENV: 'staging',
    API_KEY: 'a-sufficiently-long-staging-key',
    CORS_ORIGINS: 'https://tasks.example.edu, https://admin.example.edu',
  });

  assert.deepEqual(config.security.corsOrigins, [
    'https://tasks.example.edu',
    'https://admin.example.edu',
  ]);
});

test('buildConfig rejects an unknown environment', () => {
  assert.throws(
    () => buildConfig({ ...validRaw, NODE_ENV: 'uat' }),
    (error) => error instanceof ConfigurationError && /NODE_ENV must be one of/.test(error.message),
  );
  assert.equal(VALID_ENVIRONMENTS.length, 4);
});

test('buildConfig rejects a non-numeric or out-of-range port', () => {
  assert.throws(() => buildConfig({ ...validRaw, PORT: 'http' }), ConfigurationError);
  assert.throws(() => buildConfig({ ...validRaw, PORT: '70000' }), ConfigurationError);
});

test('buildConfig requires a strong API key in production-like environments', () => {
  assert.throws(
    () => buildConfig({ ...validRaw, NODE_ENV: 'production', API_KEY: '' }),
    (error) => error instanceof ConfigurationError && /API_KEY must be set/.test(error.message),
  );

  assert.throws(
    () => buildConfig({ ...validRaw, NODE_ENV: 'staging', API_KEY: 'short' }),
    /API_KEY must be set to at least 16 characters/,
  );
});

test('buildConfig refuses a wildcard CORS origin in production-like environments', () => {
  assert.throws(
    () =>
      buildConfig({
        ...validRaw,
        NODE_ENV: 'production',
        API_KEY: 'a-sufficiently-long-production-key',
        CORS_ORIGINS: '*',
      }),
    /CORS_ORIGINS must not contain/,
  );
});

test('buildConfig reports every problem at once instead of only the first', () => {
  try {
    buildConfig({ ...validRaw, NODE_ENV: 'production', PORT: '-1', LOG_LEVEL: 'verbose' });
    assert.fail('expected buildConfig to throw');
  } catch (error) {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(error.problems.length >= 3, `expected several problems, received ${error.problems.length}`);
  }
});

test('buildConfig defaults the log format to JSON in production-like environments', () => {
  const config = buildConfig({
    ...validRaw,
    NODE_ENV: 'production',
    API_KEY: 'a-sufficiently-long-production-key',
    CORS_ORIGINS: 'https://tasks.example.edu',
    LOG_FORMAT: undefined,
  });

  assert.equal(config.logging.format, 'json');
});
