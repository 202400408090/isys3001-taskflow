/**
 * Process entry point.
 *
 * Responsibility is limited to three things that must not be tested through the
 * HTTP surface:
 *
 *   1. Build the configuration from the environment and fail fast if invalid.
 *   2. Start the server and register the shutdown handlers.
 *   3. Translate an operating-system signal into an orderly shutdown.
 *
 * A start-up failure is reported and exits non-zero, so a container
 * orchestrator marks the instance unhealthy rather than leaving a
 * half-configured process running.
 */

import { loadConfig, ConfigurationError } from './config/index.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigurationError) {
    // Written to stderr deliberately: this is not an application log line, it is
    // an operator-facing diagnostic, and it must appear even when LOG_LEVEL is
    // set above `error`.
    process.stderr.write(`\nConfiguration error\n${'-'.repeat(72)}\n${error.message}\n\n`);
    process.exit(1);
  }
  throw error;
}

const app = createApp({ config });
const { logger } = app;

const server = app.server.listen(config.server.port, config.server.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.server.port;

  logger.info('server listening', {
    url: `http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${port}`,
    environment: config.env,
    version: config.version,
    commit: config.gitCommit,
    pid: process.pid,
    node: process.version,
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error('port already in use', { port: config.server.port, hint: 'Set PORT to a free port.' });
  } else if (error.code === 'EACCES') {
    logger.error('insufficient privileges to bind the port', { port: config.server.port });
  } else {
    logger.error('server error', { code: error.code, message: error.message });
  }
  process.exit(1);
});

/** Wait for in-flight requests, but do not wait forever. */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('shutdown requested', { signal });

  const forceExit = setTimeout(() => {
    logger.warn('shutdown deadline exceeded, forcing exit', { timeoutMs: 10_000 });
    process.exit(1);
  }, 10_000);
  // Do not keep the event loop alive purely for the timer.
  forceExit.unref();

  try {
    await app.close();
    logger.info('shutdown complete', { signal });
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error('shutdown failed', { message: error.message });
    clearTimeout(forceExit);
    process.exit(1);
  }
}

// SIGTERM is what Docker and Kubernetes send; SIGINT is Ctrl+C.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejected promise outside a request context must not leave a running process
// with an unreported fault.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

export { app, server, config };
