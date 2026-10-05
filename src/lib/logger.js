/**
 * Minimal structured logger.
 *
 * Configuration management concern: the log *destination and verbosity* are
 * environment configuration, not code. Nothing in this module reads the
 * environment directly - it is handed an already-validated config object.
 *
 * Node.js 24 ships `process.stdout.write`, so no logging library is needed.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Fields that must never reach the log stream. */
const REDACTED_KEYS = new Set([
  'apiKey',
  'api_key',
  'apikey',
  'authorization',
  'password',
  'secret',
  'token',
  'x-api-key',
]);

/**
 * Recursively replace sensitive field values with `[redacted]`.
 * Prevents a configuration dump or a request log from leaking a secret.
 */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1),
    ]),
  );
}

/**
 * Wrap a raw millisecond duration into a compact, greppable string.
 */
function formatDuration(ms) {
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function createLogger({ level = 'info', format = 'pretty', name = 'app' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (levelName, message, meta = {}) => {
    if (LEVELS[levelName] < threshold) return;

    const payload = redact(meta);
    const line =
      format === 'json'
        ? JSON.stringify({
            ts: new Date().toISOString(),
            level: levelName,
            logger: name,
            msg: message,
            ...payload,
          })
        : [
            new Date().toISOString(),
            levelName.toUpperCase().padEnd(5),
            `[${name}]`,
            message,
            Object.keys(payload).length ? JSON.stringify(payload) : '',
          ]
            .filter(Boolean)
            .join(' ');

    process.stdout.write(`${line}\n`);
  };

  return {
    level,
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),

    /**
     * Return a logger that automatically attaches the given metadata to every
     * line - used to stamp a request id onto all logs produced while handling
     * one request.
     */
    child(boundMeta = {}) {
      const child = createLogger({ level, format, name });
      return {
        ...child,
        debug: (m, meta) => emit('debug', m, { ...boundMeta, ...meta }),
        info: (m, meta) => emit('info', m, { ...boundMeta, ...meta }),
        warn: (m, meta) => emit('warn', m, { ...boundMeta, ...meta }),
        error: (m, meta) => emit('error', m, { ...boundMeta, ...meta }),
        child: (extra) => child.child({ ...boundMeta, ...extra }),
      };
    },
  };
}

export { formatDuration };
