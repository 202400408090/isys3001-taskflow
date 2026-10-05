/**
 * Domain error types.
 *
 * Route handlers translate these into HTTP responses in exactly one place
 * (src/middleware/error-handler.js), which keeps status-code decisions out of
 * the business logic.
 */

export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

/** 400 - the request is syntactically valid but semantically unusable. */
export class ValidationError extends AppError {
  constructor(message = 'The request body failed validation.', details = null) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 401 - write authentication is enabled and the supplied key is wrong. */
export class AuthenticationError extends AppError {
  constructor(message = 'A valid X-API-Key header is required for this operation.') {
    super(message, { status: 401, code: 'UNAUTHENTICATED' });
  }
}

/** 404 - the addressed resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

/**
 * 409 - the write conflicts with the current state of the resource.
 * Raised by optimistic concurrency control when a client supplies a version
 * that is no longer current.
 */
export class ConflictError extends AppError {
  constructor(message = 'The resource was modified by another request.', details = null) {
    super(message, { status: 409, code: 'CONFLICT', details });
  }
}

/** 429 - the client exceeded its request budget for the window. */
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests.', details = null) {
    super(message, { status: 429, code: 'RATE_LIMITED', details });
  }
}
