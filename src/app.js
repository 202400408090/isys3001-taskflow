/**
 * Application assembly.
 *
 * This module builds a request handler but deliberately does NOT call
 * `listen`. That separation is what makes the whole HTTP surface testable: the
 * suite imports this factory, binds port 0 and issues real requests, with no
 * mocking of the server and no fixture that can drift from production.
 *
 * Middleware order is decided here, in one readable list, because order is the
 * single most consequential thing about a middleware pipeline.
 */

import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './lib/logger.js';
import { Router } from './lib/router.js';
import { sendJson } from './lib/http.js';
import { getDatabase, closeDatabase } from './db/connection.js';
import { runMigrations, migrationStatus } from './db/migrate.js';
import { requestContext, accessLog, cors, rateLimit, requireApiKey, staticFiles, headOnly } from './middleware/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createHealthRoutes } from './routes/health.routes.js';
import { createTaskRoutes } from './routes/tasks.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, '..', 'public');

/** File extension to response content type. */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * Read the static client into memory once.
 *
 * Assets are baked into the image at build time and cannot change while the
 * process runs, so reading them per request would be wasted syscalls. The size
 * is reported so that an unexpectedly empty client is visible at start-up.
 */
export function loadStaticAssets(directory = PUBLIC_DIR) {
  const assets = new Map();

  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Normalise to forward slashes so the map key matches a URL pathname
        // regardless of the separator the host filesystem uses.
        const urlPath = `/${relative(directory, fullPath).split(/[\\/]/).join('/')}`;
        assets.set(urlPath, {
          body: readFileSync(fullPath),
          contentType: CONTENT_TYPES.get(extname(fullPath).toLowerCase()) ?? 'application/octet-stream',
          size: statSync(fullPath).size,
        });
      }
    }
  };

  walk(directory);
  return assets;
}

/**
 * Extract the query string as a plain object.
 * Repeated keys keep their last value, which is adequate for this API and is
 * documented rather than silently surprising.
 */
function parseQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) query[key] = value;
  return query;
}

/**
 * Build the application.
 *
 * @param {{ config: object, db?: object, logger?: object }} options
 * @returns {{ server: import('node:http').Server, close: () => Promise<void>,
 *            db: object, migrate: () => object, router: Router, logger: object,
 *            startedAt: Date }}
 */
export function createApp({ config, db: injectedDb, logger: injectedLogger }) {
  const logger =
    injectedLogger ?? createLogger({ level: config.logging.level, format: config.logging.format, name: 'taskflow' });

  const db = injectedDb ?? getDatabase(config.database, { logger });

  // Apply pending migrations at start-up. A schema that does not match the code
  // is a failure to boot, not a runtime surprise on the first request.
  const migrationResult = runMigrations(db, { logger });
  if (migrationResult.applied.length > 0) {
    logger.info('schema brought up to date', { applied: migrationResult.applied });
  }

  const assets = loadStaticAssets();
  logger.info('static client loaded', { files: assets.size, bytes: [...assets.values()].reduce((sum, asset) => sum + asset.size, 0) });

  const startedAt = new Date();
  const health = createHealthRoutes({ config, db, logger, startedAt });
  const tasks = createTaskRoutes({ config, db, logger });

  const router = new Router();

  /**
   * Register a read endpoint for both GET and HEAD.
   *
   * A GET registration is completed with a HEAD entry whose body writes are
   * suppressed, so the runtime route table documents both methods and a HEAD
   * request never serialises a payload it will not send.
   */
  const read = (pattern, handler, meta) => {
    router.get(pattern, handler, { ...meta, head: false });
    router.head(pattern, headOnly(handler), meta);
    return router;
  };

  read('/healthz', health.live, { description: 'Liveness probe' });
  read('/readyz', health.ready, { description: 'Readiness probe including a database check' });
  read('/api/v1/meta', health.meta, { description: 'Description of the running instance' });
  read('/api/v1/tasks', tasks.list, { description: 'List tasks with filtering and pagination' });
  read('/api/v1/tasks/summary', tasks.summary, { description: 'Aggregate counts for the client dashboard' });
  read('/api/v1/tasks/:id', tasks.get, { description: 'Fetch a single task by id' });
  read('/api/v1', (request, response) => {
    sendJson(response, 200, {
      data: { name: config.appName, version: config.version, routes: router.describe() },
    });
  }, { description: 'Service description and route table' });

  router
    .post('/api/v1/tasks', tasks.create, { description: 'Create a task' })
    .patch('/api/v1/tasks/:id', tasks.patch, { description: 'Update a task' })
    .delete('/api/v1/tasks/:id', tasks.delete, { description: 'Delete a task' })
    .delete('/api/v1/tasks', tasks.deleteAll, { description: 'Delete every task' });

  // Middleware pipeline, applied in this order for these reasons:
  //   1. requestContext  - everything after it can log with a correlation id
  //   2. accessLog       - records even a request rejected by a later stage
  //   3. cors            - answers preflight before any other work is done
  //   4. staticFiles     - the cheapest possible early exit for asset requests
  //   5. rateLimit       - protects the API, so it runs after cheap routes
  //   6. requireApiKey   - authentication only where it is needed
  const pipeline = [
    requestContext({ logger }),
    accessLog({ logger }),
    cors({ config }),
    staticFiles({ assets, logger }),
    rateLimit({ config, logger }),
    requireApiKey({ config }),
  ];

  const handleError = errorHandler({ config });
  const handleNotFound = notFoundHandler({ config });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    request.pathname = url.pathname;
    // A trailing slash is normalised so /api/v1/tasks/ and /api/v1/tasks match
    // the same route instead of one of them 404-ing.
    if (request.pathname.length > 1 && request.pathname.endsWith('/')) {
      request.pathname = request.pathname.slice(0, -1);
    }
    request.query = parseQuery(url.searchParams);
    request.clientIp = request.socket.remoteAddress ?? undefined;

    // Walk the pipeline, then dispatch to the matched route.
    let index = 0;
    const advance = (currentRequest, currentResponse) => {
      const stage = pipeline[index];
      index += 1;
      if (!stage) {
        dispatch(currentRequest, currentResponse);
        return;
      }
      stage(currentRequest, currentResponse, advance);
    };

    const dispatch = (currentRequest, currentResponse) => {
      const match = router.match(currentRequest.method, currentRequest.pathname);

      if (!match) {
        handleNotFound(currentRequest, currentResponse);
        return;
      }

      if (!match.handler) {
        // The path exists but not for this method. Saying so is more useful than
        // a 404, and the Allow header tells the client what to try instead.
        sendJson(
          currentResponse,
          405,
          {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: `${currentRequest.method} is not supported for ${currentRequest.pathname}.`,
              requestId: currentRequest.id,
            },
          },
          { Allow: match.allowedMethods.join(', ') },
        );
        return;
      }

      Promise.resolve()
        .then(() => match.handler(currentRequest, currentResponse, { params: match.params }))
        .catch((error) => handleError(error, currentRequest, currentResponse));
    };

    try {
      advance(request, response);
    } catch (error) {
      handleError(error, request, response);
    }
  });

  // Fail fast on a request that produces no response, instead of holding the
  // socket open until the client gives up.
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    db,
    logger,
    router,
    startedAt,
    migrate: () => runMigrations(db, { logger }),
    status: () => migrationStatus(db),

    /** Stop accepting connections, then release the database handle. */
    async close() {
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      // Only close a connection this factory opened; an injected one belongs to
      // the caller, which is how the test suite reuses a single in-memory store.
      if (!injectedDb) closeDatabase({ logger });
    },
  };
}
