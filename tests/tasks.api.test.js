/**
 * Task API contract tests.
 *
 * These tests drive the real HTTP surface over a real socket. They are written
 * as a specification of the API's behaviour: each test name states a rule a
 * client may rely on, and the assertions are the evidence for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, taskPayload, UUID_V4 } from './helpers.js';

test('POST /api/v1/tasks creates a task and returns 201 with a Location header', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload({ description: 'Draft section 3', priority: 'high', dueDate: '2026-09-20' }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/v1/tasks/${response.data.id}`);

    assert.match(response.data.id, UUID_V4);
    assert.equal(response.data.title, 'Write the configuration management report');
    assert.equal(response.data.description, 'Draft section 3');
    assert.equal(response.data.priority, 'high');
    assert.equal(response.data.dueDate, '2026-09-20');
    assert.equal(response.data.version, 1);
    assert.equal(response.data.completedAt, null);
  });
});

test('POST /api/v1/tasks applies documented defaults for omitted optional fields', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });

    assert.equal(response.status, 201);
    assert.equal(response.data.status, 'todo');
    assert.equal(response.data.priority, 'medium');
    assert.equal(response.data.description, '');
    assert.equal(response.data.dueDate, null);
  });
});

test('POST /api/v1/tasks rejects a payload with no title and names the missing field', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', { body: { priority: 'high' } });

    assert.equal(response.status, 400);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
    assert.ok(response.error.details.fields.some((problem) => problem.field === 'title'));
  });
});

test('POST /api/v1/tasks reports every invalid field at once, not one per request', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', {
      body: { title: '', status: 'nearly-done', priority: 'whenever', dueDate: '2026-02-31' },
    });

    assert.equal(response.status, 400);
    const fields = response.error.details.fields.map((problem) => problem.field).sort();
    assert.deepEqual(fields, ['dueDate', 'priority', 'status', 'title']);
  });
});

test('POST /api/v1/tasks rejects a calendar date that matches the pattern but does not exist', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload({ dueDate: '2026-02-31' }),
    });

    assert.equal(response.status, 400);
    assert.ok(response.error.details.fields.some((problem) => problem.field === 'dueDate'));
  });
});

test('GET /api/v1/tasks/:id returns the task, and 404 for an unknown but valid id', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });

    const found = await server.request('GET', `/api/v1/tasks/${created.data.id}`);
    assert.equal(found.status, 200);
    assert.equal(found.data.id, created.data.id);

    const missing = await server.request('GET', '/api/v1/tasks/00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    assert.equal(missing.error.code, 'NOT_FOUND');
  });
});

test('GET /api/v1/tasks/:id rejects a malformed id with 400 instead of querying the database', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/api/v1/tasks/not-a-uuid');

    assert.equal(response.status, 400);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  });
});

test('PATCH /api/v1/tasks/:id updates only the supplied fields and increments the version', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload({ description: 'original', priority: 'low' }),
    });

    const updated = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, {
      body: { priority: 'urgent' },
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.data.priority, 'urgent');
    assert.equal(updated.data.title, created.data.title, 'an absent field must survive the update');
    assert.equal(updated.data.description, 'original', 'an absent field must survive the update');
    assert.equal(updated.data.version, created.data.version + 1);
  });
});

test('PATCH /api/v1/tasks/:id sets completedAt when the status becomes done, and clears it otherwise', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });

    const done = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, { body: { status: 'done' } });
    assert.equal(done.data.status, 'done');
    assert.ok(done.data.completedAt, 'a completed task must record when it was completed');

    const reopened = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, {
      body: { status: 'in_progress' },
    });
    assert.equal(reopened.data.completedAt, null, 'a reopened task must not keep a completion time');
  });
});

test('PATCH /api/v1/tasks/:id refusal: a stale version is rejected with 409 rather than overwriting', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });

    // First writer succeeds.
    const first = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, {
      body: { title: 'First writer wins', version: created.data.version },
    });
    assert.equal(first.status, 200);

    // Second writer still holds version 1 and must be told to re-read.
    const second = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, {
      body: { title: 'Second writer overwrites', version: created.data.version },
    });

    assert.equal(second.status, 409);
    assert.equal(second.error.code, 'CONFLICT');
    assert.equal(second.error.details.currentVersion, first.data.version);

    // The first writer's value must have survived.
    const current = await server.request('GET', `/api/v1/tasks/${created.data.id}`);
    assert.equal(current.data.title, 'First writer wins');
  });
});

test('PATCH /api/v1/tasks/:id rejects a payload with no updatable field', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });
    const response = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, { body: {} });

    assert.equal(response.status, 400);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  });
});

test('PATCH /api/v1/tasks/:id can clear a due date with an explicit null', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload({ dueDate: '2026-09-20' }),
    });

    const cleared = await server.request('PATCH', `/api/v1/tasks/${created.data.id}`, { body: { dueDate: null } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.dueDate, null);
  });
});

test('DELETE /api/v1/tasks/:id removes the task and a second delete returns 404', async () => {
  await withServer({}, async (server) => {
    const created = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });

    const deleted = await server.request('DELETE', `/api/v1/tasks/${created.data.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.deleted, true);

    const again = await server.request('DELETE', `/api/v1/tasks/${created.data.id}`);
    assert.equal(again.status, 404);
  });
});

test('GET /api/v1/tasks filters by status and by priority', async () => {
  await withServer({}, async (server) => {
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'A', status: 'todo', priority: 'low' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'B', status: 'done', priority: 'high' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'C', status: 'done', priority: 'low' }) });

    const done = await server.request('GET', '/api/v1/tasks?status=done');
    assert.equal(done.body.meta.total, 2);
    assert.deepEqual(done.data.map((task) => task.title).sort(), ['B', 'C']);

    const high = await server.request('GET', '/api/v1/tasks?priority=high');
    assert.equal(high.body.meta.total, 1);
    assert.equal(high.data[0].title, 'B');

    const both = await server.request('GET', '/api/v1/tasks?status=done&priority=low');
    assert.equal(both.body.meta.total, 1);
    assert.equal(both.data[0].title, 'C');
  });
});

test('GET /api/v1/tasks searches title and description', async () => {
  await withServer({}, async (server) => {
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'Write the report' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'Other', description: 'mentions report' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'Unrelated' }) });

    const response = await server.request('GET', '/api/v1/tasks?search=report');
    assert.equal(response.body.meta.total, 2);
  });
});

test('GET /api/v1/tasks treats a LIKE wildcard in the search term as a literal', async () => {
  await withServer({}, async (server) => {
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: '100% complete' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'nothing special' }) });

    const response = await server.request('GET', '/api/v1/tasks?search=%25');
    assert.equal(response.body.meta.total, 1, 'a literal "%" must not match every row');
    assert.equal(response.data[0].title, '100% complete');
  });
});

test('GET /api/v1/tasks paginates with a stable total and hasMore flag', async () => {
  await withServer({}, async (server) => {
    for (let index = 0; index < 5; index += 1) {
      await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: `Task ${index}` }) });
    }

    const first = await server.request('GET', '/api/v1/tasks?limit=2&offset=0');
    assert.equal(first.data.length, 2);
    assert.equal(first.body.meta.total, 5);
    assert.equal(first.body.meta.hasMore, true);

    const last = await server.request('GET', '/api/v1/tasks?limit=2&offset=4');
    assert.equal(last.data.length, 1);
    assert.equal(last.body.meta.hasMore, false);

    // No task may appear on two pages.
    const seen = new Set([...first.data, ...last.data].map((task) => task.id));
    assert.equal(seen.size, 3);
  });
});

test('GET /api/v1/tasks rejects malformed pagination rather than silently ignoring it', async () => {
  await withServer({}, async (server) => {
    assert.equal((await server.request('GET', '/api/v1/tasks?limit=abc')).status, 400);
    assert.equal((await server.request('GET', '/api/v1/tasks?limit=0')).status, 400);
    assert.equal((await server.request('GET', '/api/v1/tasks?limit=1000')).status, 400);
    assert.equal((await server.request('GET', '/api/v1/tasks?offset=-1')).status, 400);
  });
});

test('GET /api/v1/tasks orders by due date with undated tasks last', async () => {
  await withServer({}, async (server) => {
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'No date' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'Later', dueDate: '2026-12-01' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'Sooner', dueDate: '2026-09-01' }) });

    const response = await server.request('GET', '/api/v1/tasks');
    assert.deepEqual(response.data.map((task) => task.title), ['Sooner', 'Later', 'No date']);
  });
});

test('GET /api/v1/tasks/summary reports counts by status and the overdue total', async () => {
  await withServer({}, async (server) => {
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'A', status: 'todo' }) });
    await server.request('POST', '/api/v1/tasks', { body: taskPayload({ title: 'B', status: 'done' }) });
    await server.request('POST', '/api/v1/tasks', {
      body: taskPayload({ title: 'Overdue', status: 'todo', dueDate: '2020-01-01' }),
    });

    const response = await server.request('GET', '/api/v1/tasks/summary');
    assert.equal(response.status, 200);
    assert.equal(response.data.total, 3);
    assert.equal(response.data.byStatus.todo, 2);
    assert.equal(response.data.byStatus.done, 1);
    assert.equal(response.data.overdue, 1);
  });
});
