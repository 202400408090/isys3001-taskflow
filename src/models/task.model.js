/**
 * Task data access layer.
 *
 * The only module besides src/db/connection.js that contains SQL. Route handlers
 * call these functions and never build a statement themselves, which means a
 * change to the schema touches this file and one migration - nothing else.
 *
 * Rows are mapped from snake_case columns to a camelCase API shape in one
 * function (`toTask`), so the database naming convention and the JSON naming
 * convention stay independent of each other.
 */

import { randomUUID } from 'node:crypto';
import { NotFoundError, ConflictError } from '../lib/errors.js';

const COLUMNS = `
  id, title, description, status, priority, due_date,
  created_at, updated_at, completed_at, version
`;

/** ISO-8601 UTC timestamp with millisecond precision, matching the schema default. */
function now() {
  return new Date().toISOString();
}

/** Map a database row to the public JSON shape. */
export function toTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/**
 * Build the WHERE clause for the list endpoint.
 * Uses bound parameters only - no value is ever concatenated into SQL, so the
 * endpoint is not injectable through a filter or a search term.
 */
function buildFilters({ status, priority, search }) {
  const clauses = [];
  const params = [];

  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (priority) {
    clauses.push('priority = ?');
    params.push(priority);
  }
  if (search) {
    // Escape the LIKE wildcards so a search for a literal "%" does not match
    // every row.
    const escaped = search.replace(/[\\%_]/g, (character) => `\\${character}`);
    clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * List tasks with filtering, deterministic ordering and pagination.
 *
 * Ordering is explicit: `due_date` ascending with NULLs last, then `created_at`
 * descending as a tie-break. Without a total order, pagination can repeat or
 * skip rows when two rows compare equal.
 */
export function listTasks(db, filters) {
  const { where, params } = buildFilters(filters);

  const total = db.prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`).get(...params).total;

  // LIMIT and OFFSET are validated integers, so interpolating them is safe and
  // avoids a SQLite parser quirk with bound LIMIT parameters.
  const rows = db
    .prepare(
      `SELECT ${COLUMNS}
         FROM tasks
         ${where}
        ORDER BY (due_date IS NULL), due_date ASC, created_at DESC
        LIMIT ${filters.limit} OFFSET ${filters.offset}`,
    )
    .all(...params);

  return {
    items: rows.map(toTask),
    total,
    limit: filters.limit,
    offset: filters.offset,
    hasMore: filters.offset + rows.length < total,
  };
}

/** Fetch one task by id, or null. */
export function findTaskById(db, id) {
  return toTask(db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id));
}

/** Fetch one task by id, raising NotFoundError when it does not exist. */
export function requireTaskById(db, id) {
  const task = findTaskById(db, id);
  if (!task) throw new NotFoundError(`No task exists with id ${id}.`);
  return task;
}

/** Insert a task. The caller supplies an already-validated payload. */
export function createTask(db, input, { logger } = {}) {
  const id = randomUUID();
  const timestamp = now();
  const completedAt = input.status === 'done' ? timestamp : null;

  db.prepare(
    `INSERT INTO tasks
       (id, title, description, status, priority, due_date, created_at, updated_at, completed_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    id,
    input.title,
    input.description,
    input.status,
    input.priority,
    input.dueDate,
    timestamp,
    timestamp,
    completedAt,
  );

  logger?.debug('task created', { id, status: input.status, priority: input.priority });

  return requireTaskById(db, id);
}

/**
 * Apply a partial update.
 *
 * Optimistic concurrency control: when the client supplies the `version` it
 * last read, the UPDATE is guarded by `version = ?` and a zero row count means
 * somebody else wrote first. The client is told to re-read rather than having
 * its change silently overwrite a change it never saw.
 *
 * Status and completion time are kept consistent here so that the schema CHECK
 * constraint is satisfied by construction rather than by luck.
 */
export function updateTask(db, id, patch, { logger } = {}) {
  const existing = requireTaskById(db, id);

  if (patch.expectedVersion !== undefined && patch.expectedVersion !== existing.version) {
    throw new ConflictError('The task was modified by another request.', {
      expectedVersion: patch.expectedVersion,
      currentVersion: existing.version,
      hint: 'Re-read the task and retry with the current version.',
    });
  }

  const next = {
    title: patch.title ?? existing.title,
    description: patch.description ?? existing.description,
    status: patch.status ?? existing.status,
    priority: patch.priority ?? existing.priority,
    dueDate: 'dueDate' in patch ? patch.dueDate : existing.dueDate,
  };

  // Derive the completion timestamp from the final status rather than trusting
  // the client, so a caller cannot mark a task done without a completion time.
  let completedAt = existing.completedAt;
  if (next.status === 'done' && existing.status !== 'done') completedAt = now();
  if (next.status !== 'done') completedAt = null;

  const result = db
    .prepare(
      `UPDATE tasks
          SET title = ?, description = ?, status = ?, priority = ?, due_date = ?,
              completed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?`,
    )
    .run(
      next.title,
      next.description,
      next.status,
      next.priority,
      next.dueDate,
      completedAt,
      now(),
      id,
      existing.version,
    );

  if (result.changes === 0) {
    // Lost the race between the read above and this write.
    const current = requireTaskById(db, id);
    throw new ConflictError('The task was modified by another request while this update was being applied.', {
      currentVersion: current.version,
      hint: 'Re-read the task and retry with the current version.',
    });
  }

  logger?.debug('task updated', { id, version: existing.version + 1, fields: Object.keys(patch) });

  return requireTaskById(db, id);
}

/**
 * Delete a task.
 *
 * The version guard is optional here: a delete is idempotent from the client's
 * point of view, so a stale version is only rejected when the client explicitly
 * supplied one and asked for that protection.
 */
export function deleteTask(db, id, { expectedVersion, logger } = {}) {
  const existing = requireTaskById(db, id);

  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new ConflictError('The task was modified by another request.', {
      expectedVersion,
      currentVersion: existing.version,
    });
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  logger?.debug('task deleted', { id });

  return existing;
}

/**
 * Aggregate counts for the client dashboard.
 * A single grouped query rather than one query per status keeps the endpoint
 * O(1) in the number of statuses.
 */
export function taskSummary(db) {
  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all().map((row) => [row.status, row.count]),
  );

  const byPriority = Object.fromEntries(
    db.prepare('SELECT priority, COUNT(*) AS count FROM tasks GROUP BY priority').all().map((row) => [row.priority, row.count]),
  );

  const total = db.prepare('SELECT COUNT(*) AS total FROM tasks').get().total;

  const today = new Date().toISOString().slice(0, 10);
  const overdue = db
    .prepare("SELECT COUNT(*) AS count FROM tasks WHERE due_date IS NOT NULL AND due_date < ? AND status <> 'done'")
    .get(today).count;

  return { total, byStatus, byPriority, overdue };
}

/** Remove every task. Used by the seed script and the test suite. */
export function deleteAllTasks(db) {
  return db.prepare('DELETE FROM tasks').run().changes;
}
