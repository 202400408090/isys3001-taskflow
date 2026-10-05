/**
 * Test harness helpers.
 *
 * The suite exercises the real HTTP surface over a real socket, because a test
 * that calls a handler function directly cannot fail on middleware ordering,
 * header handling or serialisation - which is where most defects in this layer
 * actually live.
 *
 * The database is an in-memory SQLite instance shared by one test file and
 * truncated between tests, which is faster than creating a file per test and
 * still exercises migrations, constraints and triggers.
 */

import { buildConfig } from '../src/config/index.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/connection.js';
import { createLogger } from '../src/lib/logger.js';

/** Raw values that produce a valid configuration; override per test. */
const baseRaw = {
  NODE_ENV: 'test',
  PORT: '0',
  HOST: '127.0.0.1',
  APP_NAME: 'TaskFlow',
  DATABASE_PATH: ':memory:',
  API_KEY: '',
  CORS_ORIGINS: '*',
  LOG_LEVEL: 'error',
  LOG_FORMAT: 'pretty',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_REQUESTS: '1000',
  BODY_LIMIT: '64kb',
  APP_VERSION: '1.0.0-test',
  GIT_COMMIT: 'testcommit',
  BUILD_TIME: '',
};

/**
 * Start an application instance on an ephemeral port.
 *
 * Port 0 lets the operating system choose a free port, so the suite never
 * collides with a running development server and several test files can run in
 * parallel.
 */
export async function startTestServer(overrides = {}) {
  const config = buildConfig({ ...baseRaw, ...overrides });
  const logger = createLogger({ level: 'error', format: 'pretty', name: 'test' });
  const db = openDatabase(config.database, { logger });

  const app = createApp({ config, db, logger });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();

  return {
    app,
    config,
    db,
    logger,
    baseUrl: `http://127.0.0.1:${port}`,

    /**
     * Issue a request and return the parsed response.
     * Never throws on a non-2xx status: asserting on the status is the test's
     * job, so the helper returns it rather than treating it as an error.
     */
    async request(method, path, { body, headers = {}, raw } = {}) {
      const init = { method, headers: { ...headers } };

      if (body !== undefined) {
        init.headers['Content-Type'] = init.headers['Content-Type'] ?? 'application/json';
        init.body = raw ? body : JSON.stringify(body);
      }

      const response = await fetch(`${this.baseUrl}${path}`, init);
      const text = await response.text();

      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      return {
        status: response.status,
        headers: response.headers,
        text,
        body: json,
        /** `data` unwrapped, which is what most assertions want. */
        get data() {
          return json?.data;
        },
        get error() {
          return json?.error;
        },
      };
    },

    async close() {
      await app.close();
    },
  };
}

/** Convenience wrapper that guarantees teardown even when an assertion throws. */
export async function withServer(options, run) {
  const server = await startTestServer(options);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

/** Assert that a value looks like a version 4 UUID. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Build a minimal valid task payload. */
export function taskPayload(overrides = {}) {
  return { title: 'Write the configuration management report', ...overrides };
}
