/**
 * Task routes.
 *
 * Handlers stay thin on purpose: validate, call the model, shape the response.
 * No SQL, no status-code decisions about failures, and no configuration reads -
 * all three live in dedicated modules, so a handler reads as a statement of what
 * the endpoint does.
 *
 * Every handler may be `async` and may throw; the error handler downstream
 * catches both. That is why there is no try/catch in this file.
 */

import { sendOk, sendCreated, readJsonBody } from '../lib/http.js';
import { validateTaskCreate, validateTaskUpdate, validateTaskQuery, isUuid } from '../lib/validate.js';
import { ValidationError } from '../lib/errors.js';
import {
  listTasks,
  createTask,
  requireTaskById,
  updateTask,
  deleteTask,
  taskSummary,
} from '../models/task.model.js';

/** Reject a syntactically invalid id before it reaches the database. */
function assertUsableId(id) {
  if (!isUuid(id)) {
    throw new ValidationError(`"${id}" is not a valid task id.`, {
      fields: [{ field: 'id', message: 'A task id must be a version 4 UUID.' }],
    });
  }
  return id;
}

export function createTaskRoutes({ config, db, logger }) {
  return {
    /** GET /api/v1/tasks - filtered, ordered and paginated list. */
    list(request, response) {
      const filters = validateTaskQuery(request.query);
      const result = listTasks(db, filters);

      sendOk(response, result.items, {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.hasMore,
        requestId: request.id,
      });
    },

    /** GET /api/v1/tasks/summary - dashboard counts. */
    summary(request, response) {
      sendOk(response, taskSummary(db), { requestId: request.id });
    },

    /** GET /api/v1/tasks/:id */
    get(request, response, { params }) {
      const task = requireTaskById(db, assertUsableId(params.id));
      sendOk(response, task, { requestId: request.id });
    },

    /** POST /api/v1/tasks */
    async create(request, response) {
      const payload = validateTaskCreate(await readJsonBody(request, { limit: config.http.bodyLimit }));
      const task = createTask(db, payload, { logger: request.log });

      sendCreated(response, task, `/api/v1/tasks/${task.id}`);
    },

    /** PATCH /api/v1/tasks/:id - partial update with optional version guard. */
    async patch(request, response, { params }) {
      const id = assertUsableId(params.id);
      const patch = validateTaskUpdate(await readJsonBody(request, { limit: config.http.bodyLimit }));
      const task = updateTask(db, id, patch, { logger: request.log });

      sendOk(response, task, { requestId: request.id });
    },

    /** DELETE /api/v1/tasks/:id */
    delete(request, response, { params }) {
      const id = assertUsableId(params.id);

      // An optional If-Match style guard: the client can send the version it
      // last saw as a query parameter to avoid deleting a task somebody else
      // has since changed.
      const rawVersion = request.query.version;
      const expectedVersion = rawVersion === undefined ? undefined : Number(rawVersion);

      const removed = deleteTask(db, id, { expectedVersion, logger: request.log });

      sendOk(response, { id: removed.id, deleted: true, version: removed.version }, { requestId: request.id });
    },

    /** DELETE /api/v1/tasks - clear every task. Used by the seed script. */
    deleteAll(request, response) {
      const count = db.prepare('DELETE FROM tasks').run().changes;
      logger?.warn('all tasks deleted', { count, requestId: request.id });
      sendOk(response, { deleted: count }, { requestId: request.id });
    },
  };
}
