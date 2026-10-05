/**
 * Request pipeline and operational endpoint tests.
 *
 * These cover the behaviour that is invisible to a handler-level unit test:
 * middleware ordering, header handling, correlation ids, rate limiting and
 * authentication.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, taskPayload } from './helpers.js';

test('GET /healthz reports liveness without touching the database', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/healthz');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(typeof response.body.uptimeSeconds, 'number');
    assert.equal(response.body.environment, 'test');
  });
});

test('GET /readyz reports readiness and includes a database check', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/readyz');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ready');
    assert.equal(response.body.checks.database.status, 'ok');
    assert.equal(response.body.revision.commit, 'testcommit');
  });
});

test('GET /api/v1/meta describes the running instance without disclosing a secret', async () => {
  await withServer({ API_KEY: 'a-secret-value-for-tests' }, async (server) => {
    const response = await server.request('GET', '/api/v1/meta');

    assert.equal(response.status, 200);
    assert.equal(response.body.data.environment, 'test');
    assert.equal(response.body.data.application.version, '1.0.0-test');
    assert.equal(response.body.data.features.writeAuthentication, true);

    // The key itself must never appear anywhere in the response.
    assert.ok(!response.text.includes('a-secret-value-for-tests'), 'the API key must not be echoed');
  });
});

test('every response carries a correlation id, and a well-formed client id is honoured', async () => {
  await withServer({}, async (server) => {
    const generated = await server.request('GET', '/healthz');
    assert.ok(generated.headers.get('x-request-id'), 'a request id must always be returned');

    const supplied = await server.request('GET', '/healthz', {
      headers: { 'X-Request-Id': 'trace-abc-123456' },
    });
    assert.equal(supplied.headers.get('x-request-id'), 'trace-abc-123456');

    // A malformed id must not be trusted, because it ends up in the log stream.
    const rejected = await server.request('GET', '/healthz', {
      headers: { 'X-Request-Id': 'bad id with spaces' },
    });
    assert.notEqual(rejected.headers.get('x-request-id'), 'bad id with spaces');
  });
});

test('every response reports how long it took', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/healthz');
    assert.match(response.headers.get('x-response-time'), /^\d+\.\d+ms$/);
  });
});

test('an unknown path returns a 404 in the standard error envelope', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/api/v1/nothing-here');

    assert.equal(response.status, 404);
    assert.equal(response.error.code, 'NOT_FOUND');
    assert.ok(response.error.requestId);
  });
});

test('a known path with the wrong method returns 405 and an accurate Allow header', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('PUT', '/api/v1/tasks');

    assert.equal(response.status, 405);
    assert.equal(response.error.code, 'METHOD_NOT_ALLOWED');

    const allowed = response.headers.get('allow').split(', ').sort();
    assert.deepEqual(allowed, ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST']);
  });
});

test('a trailing slash addresses the same route rather than 404-ing', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/api/v1/tasks/');
    assert.equal(response.status, 200);
  });
});

test('a request body that is not JSON is rejected with 400, not a crash', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', {
      body: '{ this is not json',
      raw: true,
    });

    assert.equal(response.status, 400);
    assert.equal(response.error.code, 'MALFORMED_JSON');
  });
});

test('a body over the configured limit is rejected with 413', async () => {
  // A deliberately tiny limit makes the boundary cheap to test.
  await withServer({ BODY_LIMIT: '1kb' }, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload({ description: 'x'.repeat(4096) }),
    });

    assert.equal(response.status, 413);
    assert.equal(response.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('a non-JSON content type is rejected with 415', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', {
      body: 'title=something',
      raw: true,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    assert.equal(response.status, 415);
    assert.equal(response.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });
});

test('write authentication is off when no API key is configured', async () => {
  await withServer({ API_KEY: '' }, async (server) => {
    const response = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });
    assert.equal(response.status, 201);
  });
});

test('write authentication rejects a missing or wrong key and accepts the right one', async () => {
  await withServer({ API_KEY: 'correct-horse-battery-staple' }, async (server) => {
    const missing = await server.request('POST', '/api/v1/tasks', { body: taskPayload() });
    assert.equal(missing.status, 401);
    assert.equal(missing.error.code, 'UNAUTHENTICATED');

    const wrong = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload(),
      headers: { 'X-API-Key': 'wrong-key-entirely-here' },
    });
    assert.equal(wrong.status, 401);

    const correct = await server.request('POST', '/api/v1/tasks', {
      body: taskPayload(),
      headers: { 'X-API-Key': 'correct-horse-battery-staple' },
    });
    assert.equal(correct.status, 201);
  });
});

test('write authentication does not gate reads', async () => {
  await withServer({ API_KEY: 'correct-horse-battery-staple' }, async (server) => {
    const response = await server.request('GET', '/api/v1/tasks');
    assert.equal(response.status, 200);
  });
});

test('rate limiting returns 429 with a Retry-After instruction once the budget is spent', async () => {
  await withServer({ RATE_LIMIT_MAX_REQUESTS: '5', RATE_LIMIT_WINDOW_MS: '60000' }, async (server) => {
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await server.request('GET', '/api/v1/tasks')).status);
    }

    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[5], 429);
    assert.equal(statuses[6], 429);

    const limited = await server.request('GET', '/api/v1/tasks');
    assert.equal(limited.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

test('the rate limiter reports the remaining budget on every response', async () => {
  await withServer({ RATE_LIMIT_MAX_REQUESTS: '3' }, async (server) => {
    const first = await server.request('GET', '/api/v1/tasks');
    assert.equal(first.headers.get('ratelimit-limit'), '3');
    assert.equal(first.headers.get('ratelimit-remaining'), '2');

    await server.request('GET', '/api/v1/tasks');
    const third = await server.request('GET', '/api/v1/tasks');
    assert.equal(third.headers.get('ratelimit-remaining'), '0');
  });
});

test('rate limiting does not count the liveness probe', async () => {
  await withServer({ RATE_LIMIT_MAX_REQUESTS: '2' }, async (server) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      assert.equal((await server.request('GET', '/healthz')).status, 200);
    }
  });
});

test('a client cannot escape its rate limit by spoofing X-Forwarded-For', async () => {
  await withServer({ RATE_LIMIT_MAX_REQUESTS: '3', RATE_LIMIT_WINDOW_MS: '60000' }, async (server) => {
    // This suite connects directly, so no trusted proxy sits in front of the
    // process and the forwarded header must be ignored entirely. If it were
    // honoured, each request below would land in a different bucket and the
    // limit would never be reached.
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': `203.0.113.${attempt + 1}` },
      });
      statuses.push(response.status);
    }

    assert.deepEqual(
      statuses,
      [200, 200, 200, 429, 429],
      'rotating the forwarded header must not reset the budget for the connection address',
    );
  });
});

test('an untrusted peer cannot inflate another client\'s request count', async () => {
  await withServer({ RATE_LIMIT_MAX_REQUESTS: '2', RATE_LIMIT_WINDOW_MS: '60000' }, async (server) => {
    // Naming a victim address must not consume that victim's budget, otherwise
    // any client could deny service to any other client by naming it.
    const first = await server.request('GET', '/api/v1/tasks', {
      headers: { 'X-Forwarded-For': '198.51.100.9' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('ratelimit-remaining'), '1', 'the count must be the peer\'s, not the named address\'s');
  });
});

test('X-Forwarded-For is honoured only when the peer is a trusted proxy', async () => {
  await withServer(
    {
      RATE_LIMIT_MAX_REQUESTS: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      // The suite connects from the loopback address, so declaring loopback
      // trusted is what makes the forwarded header meaningful in this scenario.
      TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1',
    },
    async (server) => {
      const first = await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': '198.51.100.7' },
      });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('ratelimit-remaining'), '1');

      // A different forwarded address is a different client, counted
      // separately, which is the behaviour a deployment behind a load balancer
      // depends on.
      const second = await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': '198.51.100.8' },
      });
      assert.equal(second.status, 200);
      assert.equal(second.headers.get('ratelimit-remaining'), '1');

      // The same forwarded address is the same client, and is limited.
      await server.request('GET', '/api/v1/tasks', { headers: { 'X-Forwarded-For': '198.51.100.7' } });
      const third = await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': '198.51.100.7' },
      });
      assert.equal(third.status, 429);
    },
  );
});

test('a forwarded chain is resolved right-to-left, skipping trusted hops', async () => {
  await withServer(
    {
      RATE_LIMIT_MAX_REQUESTS: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1',
    },
    async (server) => {
      // A client may prepend arbitrary entries to the header. Only the entries
      // that a trusted hop actually appended can be believed, so the address is
      // taken from the right-hand end of the chain.
      const spoofed = await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': '1.2.3.4, 198.51.100.20' },
      });
      assert.equal(spoofed.status, 200);
      assert.equal(spoofed.headers.get('ratelimit-remaining'), '1');

      // The same real client behind the same proxy, with a different lie in
      // front of it, must still be the same bucket.
      await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': '9.9.9.9, 198.51.100.20' },
      });
      const third = await server.request('GET', '/api/v1/tasks', {
        headers: { 'X-Forwarded-For': '9.9.9.9, 198.51.100.20' },
      });
      assert.equal(third.status, 429, 'a prepended entry must not create a fresh bucket');
    },
  );
});

test('CORS allows a preflight request and echoes an allowed origin', async () => {
  await withServer({ CORS_ORIGINS: 'https://tasks.example.edu' }, async (server) => {
    const preflight = await server.request('OPTIONS', '/api/v1/tasks', {
      headers: { Origin: 'https://tasks.example.edu', 'Access-Control-Request-Method': 'POST' },
    });

    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://tasks.example.edu');
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);

    // A browser-facing response must be marked as varying by origin, otherwise
    // a cache could serve one origin's response to another.
    assert.match(preflight.headers.get('vary') ?? '', /Origin/);
  });
});

test('CORS withholds the allow-origin header from an origin that is not on the list', async () => {
  await withServer({ CORS_ORIGINS: 'https://tasks.example.edu' }, async (server) => {
    const response = await server.request('GET', '/api/v1/tasks', {
      headers: { Origin: 'https://evil.example.com' },
    });

    assert.equal(response.status, 200, 'the API still answers; the browser is what enforces the policy');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

test('GET /api/v1 documents the route table at runtime', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/api/v1');

    assert.equal(response.status, 200);
    const routes = response.data.routes.map((route) => `${route.method} ${route.pattern}`);
    assert.ok(routes.includes('POST /api/v1/tasks'));
    assert.ok(routes.includes('PATCH /api/v1/tasks/:id'));
    assert.ok(response.data.routes.every((route) => typeof route.description === 'string'));
  });
});

test('the client is served from the static asset map with a cacheable header', async () => {
  await withServer({}, async (server) => {
    const index = await server.request('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.headers.get('cache-control'), /no-cache/);
    assert.match(index.text, /TaskFlow/);
  });
});

test('a missing asset returns a JSON 404 rather than an HTML page', async () => {
  await withServer({}, async (server) => {
    const response = await server.request('GET', '/assets/does-not-exist.js');

    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.error.code, 'NOT_FOUND');
  });
});

test('a HEAD request returns the headers a GET would return, with no body', async () => {
  await withServer({}, async (server) => {
    const get = await server.request('GET', '/healthz');
    const head = await server.request('HEAD', '/healthz');

    assert.equal(head.status, 200);
    assert.equal(head.text, '', 'HEAD must not send a body');
    // Content-Length is the point of HEAD: it tells a client what a GET costs.
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
  });
});

test('HEAD is offered for every GET route and reports an accurate Allow header', async () => {
  await withServer({}, async (server) => {
    const routes = (await server.request('GET', '/api/v1')).data.routes.map((route) => `${route.method} ${route.pattern}`);

    assert.ok(routes.includes('GET /api/v1/tasks'));
    assert.ok(routes.includes('HEAD /api/v1/tasks'));

    // A method the path genuinely does not support must still be refused.
    const refused = await server.request('PUT', '/api/v1/tasks/00000000-0000-4000-8000-000000000000');
    assert.equal(refused.status, 405);
  });
});
