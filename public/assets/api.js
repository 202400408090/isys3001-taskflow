/**
 * API client.
 *
 * Every network concern lives here: URL construction, the API key header, and
 * the translation of the server's error envelope into a thrown Error with a
 * useful message. The UI layer therefore contains no `fetch` call at all, which
 * keeps it testable by reasoning alone and keeps the authentication header in
 * exactly one place.
 */

/** Key under which the optional write API key is remembered in this browser. */
const API_KEY_STORAGE = 'taskflow.apiKey';

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Read the remembered API key, if the user supplied one. */
export function getApiKey() {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE) ?? '';
  } catch {
    // Private browsing can deny storage access. Falling back to "no key" is
    // correct: the server decides whether a key is required.
    return '';
  }
}

export function setApiKey(value) {
  try {
    if (value) window.localStorage.setItem(API_KEY_STORAGE, value);
    else window.localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* storage unavailable; the key simply will not persist */
  }
}

/**
 * Perform one API call.
 *
 * A non-2xx response is converted into a thrown ApiError rather than returned,
 * so a caller cannot forget to check the status. The server's error envelope
 * carries a machine-readable code and, for validation failures, the list of
 * offending fields - both are preserved on the error for the caller to act on.
 */
async function request(method, path, { body, signal } = {}) {
  const headers = { Accept: 'application/json' };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const apiKey = getApiKey();
  if (apiKey) headers['X-API-Key'] = apiKey;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new ApiError('The server could not be reached. Check that it is running.', {
      status: 0,
      code: 'NETWORK_ERROR',
    });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from a proxy or an HTML error page.
    if (!response.ok) {
      throw new ApiError(`The server returned an unreadable response (HTTP ${response.status}).`, {
        status: response.status,
        code: 'UNREADABLE_RESPONSE',
      });
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `The request failed with HTTP ${response.status}.`, {
      status: response.status,
      code: payload?.error?.code ?? 'HTTP_ERROR',
      details: payload?.error?.details ?? null,
    });
  }

  return payload;
}

/** Build a query string, omitting empty values so the server sees only real filters. */
function toQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const api = {
  /** Fetch the running instance description, used for the environment badge. */
  meta: () => request('GET', '/api/v1/meta'),

  list: (filters = {}, options = {}) =>
    request('GET', `/api/v1/tasks${toQuery(filters)}`, options),

  summary: (options = {}) => request('GET', '/api/v1/tasks/summary', options),

  get: (id, options = {}) => request('GET', `/api/v1/tasks/${encodeURIComponent(id)}`, options),

  create: (payload) => request('POST', '/api/v1/tasks', { body: payload }),

  update: (id, payload) => request('PATCH', `/api/v1/tasks/${encodeURIComponent(id)}`, { body: payload }),

  remove: (id, version) =>
    request('DELETE', `/api/v1/tasks/${encodeURIComponent(id)}${toQuery({ version })}`),

  removeAll: () => request('DELETE', '/api/v1/tasks'),
};

/**
 * Turn a validation failure into a field-to-message map for the form.
 * Any problem the server reports that is not tied to a known field is returned
 * under the `_form` key so it is still shown to the user.
 */
export function fieldErrorsFrom(error, knownFields) {
  const map = {};
  const fields = error?.details?.fields;
  if (!Array.isArray(fields)) return map;

  for (const problem of fields) {
    const key = knownFields.includes(problem.field) ? problem.field : '_form';
    // Keep the first message per field: repeating one field in a list of
    // several messages is worse than showing the most specific problem first.
    if (!map[key]) map[key] = problem.message;
  }

  return map;
}
