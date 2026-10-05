/**
 * Terminal error handler.
 *
 * Every unhandled failure passes through here, so the decision about which
 * detail reaches a client and which stays in the log is made in exactly one
 * place.
 *
 * Rules applied:
 *   * 4xx carries the message, because the client can act on it.
 *   * 5xx carries a generic message plus the request id, so an internal detail
 *     (a SQL fragment, a file path) is never disclosed. The full error and its
 *     stack are logged instead, and the client can quote the request id.
 *   * A response that has already started streaming cannot be replaced with a
 *     JSON error, so the connection is ended and the failure is logged.
 */

import { sendJson } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { describeDatabaseError } from '../db/connection.js';

export function errorHandler({ config }) {
  return (error, request, response) => {
    const log = request.log ?? console;

    if (response.headersSent) {
      log.error('error after the response had started', {
        message: error?.message,
        stack: error?.stack,
      });
      response.end();
      return;
    }

    // Translate a raw driver failure into an HTTP-friendly shape before the
    // generic handling below, so a constraint violation is a 409 rather than a
    // 500 with a database message attached.
    const translated = !(error instanceof AppError) ? describeDatabaseError(error) : null;

    let status = error?.status ?? translated?.status ?? 500;
    let code = error?.code ?? translated?.code ?? 'INTERNAL_ERROR';

    // A malformed JSON body is raised by the body reader with a status but is
    // not an AppError, so its status is preserved by the line above.
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;

    const details = error?.details ?? null;
    const expose = error instanceof AppError ? error.expose : status < 500;

    if (status >= 500) {
      log.error('unhandled error', {
        code,
        message: error?.message,
        stack: error?.stack,
        method: request.method,
        path: request.pathname,
      });
    } else {
      log.warn('request failed', {
        code,
        status,
        message: error?.message,
        method: request.method,
        path: request.pathname,
      });
    }

    const headers = {};
    // Give a rate-limited client an explicit instruction rather than only a
    // status code.
    if (details?.retryAfterSeconds) headers['Retry-After'] = String(details.retryAfterSeconds);

    sendJson(
      response,
      status,
      {
        error: {
          code,
          message: expose ? error.message : 'An unexpected error occurred while handling the request.',
          ...(expose && details ? { details } : {}),
          requestId: request.id ?? null,
        },
      },
      headers,
    );
  };
}

/** 404 for a path that reached the end of the pipeline. */
export function notFoundHandler({ config }) {
  return (request, response) => {
    sendJson(response, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${request.method} ${request.pathname}.`,
        requestId: request.id ?? null,
      },
    });
  };
}
