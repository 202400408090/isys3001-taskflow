#!/usr/bin/env node
/**
 * Post-deployment smoke test.
 *
 * Verifies that a running instance is actually serving, not merely listening.
 * Exits 0 when every check passes and 1 otherwise, so a pipeline stage or an
 * operator can gate on the exit status.
 *
 * Usage:
 *   node scripts/smoke-test.js                        # http://127.0.0.1:3000
 *   SMOKE_BASE_URL=https://staging.example.edu node scripts/smoke-test.js
 *   API_KEY=... node scripts/smoke-test.js            # also exercise a write
 */

const baseUrl = (process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, '');
const apiKey = process.env.API_KEY ?? process.env.SMOKE_API_KEY ?? '';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 5000);

let passed = 0;
const failures = [];

/** Run one named check; record the outcome rather than throwing. */
async function check(name, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const detail = await run(controller.signal);
    passed += 1;
    process.stdout.write(`  ok    ${name}${detail ? ` (${detail})` : ''}\n`);
  } catch (error) {
    failures.push({ name, message: error.message });
    process.stdout.write(`  FAIL  ${name}: ${error.message}\n`);
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}), ...options.headers },
  });
  const text = await response.text();

  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`expected JSON from ${path} but received: ${text.slice(0, 120)}`);
  }

  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

process.stdout.write(`\nSmoke test against ${baseUrl}\n${'-'.repeat(72)}\n`);

await check('GET /healthz reports the process is alive', async (signal) => {
  const { response, body } = await request('/healthz', { signal });
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert(body.status === 'ok', `expected status "ok", received "${body.status}"`);
  return `v${body.version} in ${body.environment}`;
});

await check('GET /readyz reports the instance can serve traffic', async (signal) => {
  const { response, body } = await request('/readyz', { signal });
  assert(response.status === 200, `expected 200, received ${response.status} (${JSON.stringify(body?.checks)})`);
  assert(body.checks?.database?.status === 'ok', 'the database check is not ok');
  return `commit ${body.revision?.commit ?? 'unknown'}`;
});

await check('GET /api/v1/meta identifies the running revision', async (signal) => {
  const { response, body } = await request('/api/v1/meta', { signal });
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert(body.data?.application?.version, 'no application version was reported');
  assert(body.data?.revision?.commit, 'no commit was reported');
  return `${body.data.application.version} @ ${String(body.data.revision.commit).slice(0, 12)}`;
});

await check('GET /api/v1/tasks returns a paginated list', async (signal) => {
  const { response, body } = await request('/api/v1/tasks?limit=5', { signal });
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert(Array.isArray(body.data), 'the payload does not contain an array of tasks');
  assert(typeof body.meta?.total === 'number', 'the response has no total count');
  return `${body.meta.total} task(s) in the store`;
});

await check('GET / serves the single-page client', async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert(/TaskFlow/i.test(html), 'the served page does not mention TaskFlow');
  return `${html.length} bytes of HTML`;
});

await check('GET /assets/app.js serves the client script', async () => {
  const response = await fetch(`${baseUrl}/assets/app.js`);
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert(/text\/javascript/.test(response.headers.get('content-type') ?? ''), 'wrong content type');
  return response.headers.get('content-type');
});

await check('an unknown route returns a JSON 404', async (signal) => {
  const { response, body } = await request('/api/v1/definitely-not-a-route', { signal });
  assert(response.status === 404, `expected 404, received ${response.status}`);
  assert(body.error?.code === 'NOT_FOUND', 'the error envelope is missing its code');
});

await check('an invalid task payload is refused with field detail', async (signal) => {
  const { response, body } = await request('/api/v1/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '' }),
    signal,
  });

  // 401 when write authentication is enabled, 400 when the payload is judged
  // first - both prove the write path is reachable and defended.
  assert(
    response.status === 400 || response.status === 401,
    `expected 400 or 401, received ${response.status}`,
  );
  assert(body.error?.code, 'the error envelope is missing its code');
  return `HTTP ${response.status} ${body.error.code}`;
});

if (apiKey) {
  await check('a valid API key permits a write, and the task is then removed', async (signal) => {
    const created = await request('/api/v1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke test task', priority: 'low' }),
      signal,
    });

    assert(created.response.status === 201, `create expected 201, received ${created.response.status}`);
    const id = created.body.data.id;

    const removed = await request(`/api/v1/tasks/${id}`, { method: 'DELETE', signal });
    assert(removed.response.status === 200, `delete expected 200, received ${removed.response.status}`);

    return 'created and deleted a task';
  });
} else {
  process.stdout.write('  skip  write-path check (set API_KEY to enable it)\n');
}

process.stdout.write(`${'-'.repeat(72)}\n`);

if (failures.length > 0) {
  process.stdout.write(`${passed} passed, ${failures.length} failed\n\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure.name}: ${failure.message}\n`);
  process.stdout.write('\n');
  process.exit(1);
}

process.stdout.write(`${passed} checks passed. The instance is serving correctly.\n\n`);
process.exit(0);
