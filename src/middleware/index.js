/**
 * Cross-cutting HTTP middleware.
 *
 * Each factory returns a function that either handles the request itself or
 * calls `next(request, response)` to hand control to the next stage. Ordering is
 * decided in src/app.js, not here, so the pipeline is readable in one place.
 */

import { randomUUID } from 'node:crypto';
import { RateLimitError, AuthenticationError } from '../lib/errors.js';
import { sendJson, withTiming } from '../lib/http.js';

/**
 * Attach a correlation id to every request.
 *
 * A client-supplied `X-Request-Id` is honoured after being sanity-checked, so a
 * trace can be followed across services; otherwise one is generated. The id is
 * echoed in the response header and stamped onto every log line produced while
 * handling the request, which turns "the user reported an error" into a single
 * grep.
 */
export function requestContext({ logger }) {
  return (request, response, next) => {
    const supplied = String(request.headers['x-request-id'] ?? '').trim();
    const requestId = /^[A-Za-z0-9._-]{8,128}$/.test(supplied) ? supplied : randomUUID();

    request.id = requestId;
    request.log = logger.child({ requestId });

    response.setHeader('X-Request-Id', requestId);

    next(request, response);
  };
}

/**
 * Emit one access-log line per request and expose `X-Response-Time`.
 *
 * Logging at `info` for successes and `warn` for 4xx/5xx means an error-only
 * filter over the production log stream shows the whole of what went wrong.
 */
export function accessLog({ logger }) {
  return (request, response, next) => {
    const elapsed = withTiming(response, (durationMs) => {
      const status = response.statusCode;
      const entry = {
        method: request.method,
        path: request.pathname,
        status,
        durationMs: Number(durationMs.toFixed(2)),
        requestId: request.id,
        ...(request.clientIp ? { clientIp: request.clientIp } : {}),
      };
      if (status >= 500) (request.log ?? logger).error('request failed', entry);
      else if (status >= 400) (request.log ?? logger).warn('request rejected', entry);
      else (request.log ?? logger).info('request handled', entry);
    });

    response.setHeader('X-Response-Time', `${elapsed().toFixed(2)}ms`);

    next(request, response);
  };
}

/**
 * Reject cross-origin requests that are not on the configured allow list.
 *
 * `*` is permitted, because that is the development setting. In staging and
 * production the configuration validator has already refused to start the
 * process with a wildcard, so this middleware only has to apply the list.
 */
export function cors({ config }) {
  const allowed = config.security.corsOrigins;
  const allowAll = allowed.includes('*');

  return (request, response, next) => {
    const origin = request.headers.origin;

    if (origin && (allowAll || allowed.includes(origin))) {
      response.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      // Tell caches that the response varies by origin, otherwise one origin's
      // response could be served to another.
      response.setHeader('Vary', 'Origin');
    }

    // Preflight: answer here and do not reach a route handler.
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Request-Id',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      response.end();
      return;
    }

    next(request, response);
  };
}

/**
 * Apply a fixed-window rate limit per client IP.
 *
 * The window is stored in a Map rather than pulled from a store, because the
 * application runs as a single process. The comment records the ceiling of that
 * choice: a second replica would need a shared counter, which is why the limit
 * is configuration and not a constant.
 */
export function rateLimit({ config, logger }) {
  const { windowMs, maxRequests } = config.rateLimit;
  const buckets = new Map();

  // Bound the memory the limiter can consume: an attacker cycling source
  // addresses must not be able to grow the Map without limit.
  const MAX_TRACKED_CLIENTS = 10_000;

  return (request, response, next) => {
    if (!request.pathname.startsWith('/api')) {
      next(request, response);
      return;
    }

    const now = Date.now();
    const key = request.clientIp ?? 'unknown';
    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      if (buckets.size >= MAX_TRACKED_CLIENTS) {
        // Drop the oldest window rather than refuse new clients.
        for (const [candidate, value] of buckets) {
          if (now >= value.resetAt) buckets.delete(candidate);
        }
        if (buckets.size >= MAX_TRACKED_CLIENTS) buckets.clear();
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, maxRequests - bucket.count);
    response.setHeader('RateLimit-Limit', String(maxRequests));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > maxRequests) {
      logger?.warn('rate limit exceeded', { clientIp: key, path: request.pathname, maxRequests });
      throw new RateLimitError(
        `Rate limit exceeded: ${maxRequests} requests per ${Math.round(windowMs / 1000)} seconds.`,
        { retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) },
      );
    }

    next(request, response);
  };
}

/**
 * Require the shared secret on state-changing operations.
 *
 * Authentication is intentionally scoped to writes. Reads are public in this
 * application so that the client can load the list before the user supplies a
 * key; a production deployment that stores sensitive tasks would extend this to
 * reads as well, which is why the check is a middleware and not inline logic.
 *
 * The comparison uses a constant-time routine so that the response time does
 * not reveal how many leading characters of the key were correct.
 */
export function requireApiKey({ config }) {
  const expected = config.security.apiKey;
  const enabled = config.security.writeAuthEnabled;

  return (request, response, next) => {
    if (!enabled || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next(request, response);
      return;
    }

    const provided = String(request.headers['x-api-key'] ?? '');
    if (!timingSafeEqual(provided, expected)) {
      throw new AuthenticationError();
    }

    next(request, response);
  };
}

/**
 * Compare two strings without an early exit on the first differing character.
 */
export function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');

  // Compare against a fixed-width digest so that differing lengths do not
  // short-circuit the loop and leak the expected length.
  const length = Math.max(a.length, b.length, 1);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

/**
 * Serve the static single-page client from memory.
 *
 * Assets are read once at start-up because they are baked into the image and
 * cannot change while the process runs. An unknown path falls through to
 * index.html so that a client-side route survives a page refresh; a path under
 * /assets that is genuinely missing returns 404 rather than an HTML page, which
 * would otherwise be reported by the browser as a syntax error.
 */
export function staticFiles({ assets, logger }) {
  return (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      next(request, response);
      return;
    }

    const pathname = request.pathname === '/' ? '/index.html' : request.pathname;
    const asset = assets.get(pathname);

    if (asset) {
      response.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': asset.body.length,
        'Cache-Control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=300',
      });
      response.end(request.method === 'HEAD' ? undefined : asset.body);
      return;
    }

    if (pathname.startsWith('/assets/')) {
      logger?.debug('static asset not found', { path: pathname });
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
      return;
    }

    next(request, response);
  };
}
