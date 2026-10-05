/**
 * Small pattern-matching router.
 *
 * Node's standard library has no router, and a routing library would be the only
 * runtime dependency in the project. `URLPattern` is available as a global in
 * Node.js 24, so it provides path matching with typed parameters at zero
 * dependency cost. See docs/adr/0005-sqlite-via-node-builtin.md for the same
 * argument applied to the data store.
 *
 * Path parameters are percent-decoded, because a task id could in principle
 * arrive encoded and a handler must receive the real value.
 */

export class Router {
  #routes = [];

  /**
   * Register a route.
   *
   * @param {string} method uppercase HTTP method
   * @param {string} pattern URLPattern pathname pattern, e.g. `/api/v1/tasks/:id`
   * @param {(request: object, response: object, context: object) => any | Promise<any>} handler
   * @param {{ description?: string }} [meta] documentation used by GET /api/v1/meta
   */
  add(method, pattern, handler, meta = {}) {
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      matcher: new URLPattern({ pathname: pattern }),
      handler,
      description: meta.description ?? null,
    });
    return this;
  }

  get(pattern, handler, meta) {
    return this.add('GET', pattern, handler, meta);
  }

  post(pattern, handler, meta) {
    return this.add('POST', pattern, handler, meta);
  }

  patch(pattern, handler, meta) {
    return this.add('PATCH', pattern, handler, meta);
  }

  delete(pattern, handler, meta) {
    return this.add('DELETE', pattern, handler, meta);
  }

  /** Route table, used to document the API at runtime. */
  describe() {
    return this.#routes.map(({ method, pattern, description }) => ({ method, pattern, description }));
  }

  /**
   * Find a handler for a concrete pathname.
   *
   * Returns `{ handler, params, allowedMethods }`. `allowedMethods` is populated
   * when the path matches but the method does not, so the caller can answer 405
   * with an accurate `Allow` header instead of a misleading 404.
   */
  match(method, pathname) {
    const wanted = method.toUpperCase();
    const allowedMethods = new Set();

    for (const route of this.#routes) {
      const result = route.matcher.exec({ pathname });
      if (!result) continue;

      if (route.method !== wanted) {
        allowedMethods.add(route.method);
        continue;
      }

      const params = Object.fromEntries(
        Object.entries(result.pathname.groups).map(([key, value]) => [
          key,
          value === undefined ? undefined : decodeURIComponent(value),
        ]),
      );

      return { handler: route.handler, params, allowedMethods: [] };
    }

    if (allowedMethods.size > 0) {
      allowedMethods.add('OPTIONS');
      return { handler: null, params: null, allowedMethods: [...allowedMethods].sort() };
    }

    return null;
  }
}
