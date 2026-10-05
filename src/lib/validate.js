/**
 * Input validation.
 *
 * Validation lives in one module and is shared by every route, so a rule is
 * stated once. Every rule that the database also enforces (the status and
 * priority enumerations, the due-date format) is duplicated deliberately: the
 * API rejects bad input with a helpful message, and the schema remains the last
 * line of defence if a code path ever bypasses validation.
 */

import { ValidationError } from './errors.js';

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const SEARCH_MAX_LENGTH = 100;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** ISO-8601 calendar date, YYYY-MM-DD. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** RFC 4122 version 4 UUID. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Collect field-level problems and raise one error carrying all of them.
 * Reporting every problem at once means a client fixes its request in one
 * round trip instead of discovering faults one at a time.
 */
class FieldCollector {
  constructor() {
    this.problems = [];
  }

  add(field, message) {
    this.problems.push({ field, message });
  }

  throwIfAny(message = 'The request body failed validation.') {
    if (this.problems.length > 0) {
      throw new ValidationError(message, { fields: this.problems });
    }
  }
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validateTitle(raw, collector, { required }) {
  if (raw === undefined || raw === null) {
    if (required) collector.add('title', 'A title is required.');
    return undefined;
  }
  if (typeof raw !== 'string') {
    collector.add('title', 'The title must be a string.');
    return undefined;
  }
  const value = raw.trim();
  if (value.length === 0) {
    if (required) collector.add('title', 'The title must not be empty.');
    return undefined;
  }
  if (value.length > TITLE_MAX_LENGTH) {
    collector.add('title', `The title must be at most ${TITLE_MAX_LENGTH} characters.`);
    return undefined;
  }
  return value;
}

function validateDescription(raw, collector) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    collector.add('description', 'The description must be a string.');
    return undefined;
  }
  const value = raw.trim();
  if (value.length > DESCRIPTION_MAX_LENGTH) {
    collector.add('description', `The description must be at most ${DESCRIPTION_MAX_LENGTH} characters.`);
    return undefined;
  }
  return value;
}

function validateEnum(raw, allowed, field, collector) {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    collector.add(field, `${field} must be one of: ${allowed.join(', ')}.`);
    return undefined;
  }
  return value;
}

function validateDueDate(raw, collector) {
  if (raw === undefined) return undefined;
  // An explicit null is a meaningful instruction: clear the due date.
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !DATE_PATTERN.test(raw.trim())) {
    collector.add('dueDate', 'The due date must be an ISO-8601 calendar date (YYYY-MM-DD).');
    return undefined;
  }

  const value = raw.trim();
  // A pattern match cannot reject 2026-02-31, so the date is round-tripped
  // through Date and compared back to the input.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    collector.add('dueDate', `"${value}" is not a real calendar date.`);
    return undefined;
  }
  return value;
}

function validateVersion(raw, collector) {
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    collector.add('version', 'The version must be a positive integer.');
    return undefined;
  }
  return value;
}

/** Validate a create-task payload. */
export function validateTaskCreate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('The request body must be a JSON object.');
  }

  const collector = new FieldCollector();
  const value = {
    title: validateTitle(body.title, collector, { required: true }),
    description: validateDescription(body.description, collector),
    status: validateEnum(body.status, TASK_STATUSES, 'status', collector),
    priority: validateEnum(body.priority, TASK_PRIORITIES, 'priority', collector),
    dueDate: validateDueDate(body.dueDate, collector),
  };
  collector.throwIfAny();

  // Apply documented defaults only after validation has passed.
  return {
    title: value.title,
    description: value.description ?? '',
    status: value.status ?? 'todo',
    priority: value.priority ?? 'medium',
    dueDate: value.dueDate ?? null,
  };
}

/**
 * Validate a partial update.
 * Absent keys are left untouched; an explicit `null` clears a nullable field.
 */
export function validateTaskUpdate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('The request body must be a JSON object.');
  }

  const collector = new FieldCollector();
  const patch = {};

  if ('title' in body) patch.title = validateTitle(body.title, collector, { required: true });
  if ('description' in body) patch.description = validateDescription(body.description, collector) ?? '';
  if ('status' in body) patch.status = validateEnum(body.status, TASK_STATUSES, 'status', collector);
  if ('priority' in body) patch.priority = validateEnum(body.priority, TASK_PRIORITIES, 'priority', collector);
  if ('dueDate' in body) patch.dueDate = validateDueDate(body.dueDate, collector);
  if ('version' in body) patch.expectedVersion = validateVersion(body.version, collector);

  collector.throwIfAny('The update payload failed validation.');

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('No updatable fields were supplied.', {
      fields: [{ field: 'body', message: `Updatable fields are: title, description, status, priority, dueDate, version.` }],
    });
  }

  return patch;
}

/** Validate the query string of the list endpoint. */
export function validateTaskQuery(query) {
  const collector = new FieldCollector();
  const result = {};

  result.status = validateEnum(query.status, TASK_STATUSES, 'status', collector);
  result.priority = validateEnum(query.priority, TASK_PRIORITIES, 'priority', collector);

  if (query.search !== undefined && query.search !== '') {
    const search = String(query.search).trim();
    if (search.length > SEARCH_MAX_LENGTH) {
      collector.add('search', `The search term must be at most ${SEARCH_MAX_LENGTH} characters.`);
    } else {
      result.search = search;
    }
  }

  for (const [field, fallback, max] of [
    ['limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE],
    ['offset', 0, Number.MAX_SAFE_INTEGER],
  ]) {
    const raw = query[field];
    if (raw === undefined || raw === '') {
      result[field] = fallback;
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      collector.add(field, `${field} must be a non-negative integer.`);
      continue;
    }
    if (field === 'limit' && (value < 1 || value > max)) {
      collector.add(field, `limit must be between 1 and ${max}.`);
      continue;
    }
    result[field] = value;
  }

  collector.throwIfAny('The query string is invalid.');

  return {
    status: result.status ?? null,
    priority: result.priority ?? null,
    search: result.search ?? null,
    limit: result.limit ?? DEFAULT_PAGE_SIZE,
    offset: result.offset ?? 0,
  };
}
