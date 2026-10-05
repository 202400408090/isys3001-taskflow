/**
 * HTTP helpers shared by every route.
 *
 * Keeping response shaping in one module is what makes the API's envelope
 * consistent: a client can rely on the same structure whether a call succeeded,
 * failed validation or hit a rate limit.
 */

/**
 * Serialise a value as a JSON response.
 *
 * `Cache-Control: no-store` is applied to every API response because the data is
 * user-specific and a cached task list in an intermediary would be a data leak.
 */
export function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload ?? null);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

/** 204 with no body. Used where the resource no longer exists. */
export function sendNoContent(response, headers = {}) {
  response.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

/** Successful single-resource response. */
export function sendOk(response, data, meta = undefined) {
  sendJson(response, 200, meta ? { data, meta } : { data });
}

/** Successful creation response with a Location header. */
export function sendCreated(response, data, location) {
  sendJson(response, 201, { data }, location ? { Location: location } : {});
}

/**
 * Read and parse a JSON request body, enforcing the configured size limit.
 *
 * The limit is enforced while streaming rather than after buffering, so an
 * oversized body is rejected without first being held in memory.
 */
export async function readJsonBody(request, { limit }) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > limit) {
    const error = new Error(`The request body exceeds the ${limit} byte limit.`);
    error.status = 413;
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }

  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.includes('application/json')) {
    const error = new Error('Content-Type must be application/json.');
    error.status = 415;
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }

  const chunks = [];
  let received = 0;

  for await (const chunk of request) {
    received += chunk.length;
    if (received > limit) {
      const error = new Error(`The request body exceeds the ${limit} byte limit.`);
      error.status = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  if (received === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('The request body is not valid JSON.');
    error.status = 400;
    error.code = 'MALFORMED_JSON';
    throw error;
  }
}

/**
 * Measure how long a response took and hand it to a callback.
 * Used for the access log and the `X-Response-Time` header.
 */
export function withTiming(response, onFinish) {
  const startedAt = process.hrtime.bigint();

  response.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    onFinish(durationMs);
  });

  return () => Number(process.hrtime.bigint() - startedAt) / 1e6;
}
