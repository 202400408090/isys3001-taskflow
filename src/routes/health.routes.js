/**
 * Liveness endpoints.
 *
 * The two probes answer different questions, and conflating them is a common
 * source of self-inflicted outages:
 *
 *   /healthz  "is this process alive?"  Cheap, checks nothing external. A
 *             failure means restart the container.
 *   /readyz   "should this instance receive traffic?" Checks the dependencies
 *             the request path actually needs. A failure means stop routing to
 *             it, but do not restart it.
 */

import { sendJson } from '../lib/http.js';
import { describeConfig } from '../config/index.js';

export function createHealthRoutes({ config, db, logger, startedAt }) {
  const bootTime = startedAt ?? new Date();

  return {
    /** Liveness. Must not touch the database. */
    live(request, response) {
      sendJson(response, 200, {
        status: 'ok',
        uptimeSeconds: Number(((Date.now() - bootTime.getTime()) / 1000).toFixed(3)),
        version: config.version,
        environment: config.env,
      });
    },

    /** Readiness. Touches the database with the cheapest possible query. */
    ready(request, response) {
      const checks = {};
      let ready = true;

      try {
        db.prepare('SELECT 1 AS ok').get();
        checks.database = { status: 'ok' };
      } catch (error) {
        ready = false;
        checks.database = { status: 'failed', message: error.message };
        logger?.error('readiness check failed', { check: 'database', message: error.message });
      }

      // A production instance with write authentication disabled is a
      // configuration fault, not a healthy state, so it fails readiness.
      if (config.isProductionLike && !config.security.writeAuthEnabled) {
        ready = false;
        checks.writeAuthentication = { status: 'failed', message: 'No API key is configured.' };
      } else {
        checks.writeAuthentication = { status: config.security.writeAuthEnabled ? 'ok' : 'disabled' };
      }

      sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        checks,
        revision: { version: config.version, commit: config.gitCommit },
      });
    },

    /**
     * Machine-readable description of the running instance.
     * This is what makes "which revision is deployed?" answerable from outside
     * the container, with no access to the host.
     */
    meta(request, response) {
      sendJson(response, 200, {
        data: describeConfig(config),
        meta: { requestId: request.id, generatedAt: new Date().toISOString() },
      });
    },
  };
}
