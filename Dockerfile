# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Production image for TaskFlow.
#
# DESIGN DECISIONS
#
# 1. Multi-stage. The `deps` stage resolves dependencies; the final stage
#    receives only what the process needs to run. Nothing from the build stage
#    is reachable at runtime.
#
# 2. The runtime dependency graph is empty (see ADR-0005), so the final stage
#    installs nothing at all. That is why there is no `npm ci` in the runtime
#    stage and why the image is small without any pruning step.
#
# 3. Non-root. The process runs as an unprivileged user, so a compromise of the
#    application does not confer root inside the container.
#
# 4. Build metadata is injected as arguments, not read from the build context,
#    so the image can report the exact commit it was built from and the same
#    source tree can produce distinct, identifiable builds.
#
# 5. A health check is declared in the image itself, so any orchestrator that
#    understands HEALTHCHECK gets the correct probe without extra configuration.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1: resolve dependencies
#
# The project has no runtime dependencies, so this stage exists to fail the
# build loudly if one is ever added without the packaging being updated. It is
# also where any future dependency installation belongs.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json ./

# `npm ci` requires a lockfile. The repository intentionally ships no lockfile
# because there is nothing to lock: the dependency graph is empty. If a
# dependency is added later, generate package-lock.json, commit it, and replace
# this guard with `RUN npm ci --omit=dev`.
RUN node -e "const pkg = require('./package.json'); \
    const runtime = Object.keys(pkg.dependencies || {}); \
    if (runtime.length > 0) { \
      console.error('Runtime dependencies were added: ' + runtime.join(', ')); \
      console.error('Generate package-lock.json and switch this stage to npm ci.'); \
      process.exit(1); \
    } \
    console.log('No runtime dependencies to install.');"

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# --- Build metadata --------------------------------------------------------
# Declared after FROM so their values are scoped to this stage. They are baked
# into environment variables below and surfaced through GET /api/v1/meta.
ARG APP_VERSION=0.0.0
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ARG NODE_ENV=production

# --- Labels ----------------------------------------------------------------
# Open Container Initiative labels make the image self-describing, which is what
# a registry and a vulnerability scanner read.
LABEL org.opencontainers.image.title="TaskFlow" \
      org.opencontainers.image.description="Task management web application for the ISYS3001 software development project" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=${NODE_ENV} \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/var/lib/taskflow/taskflow.sqlite \
    LOG_FORMAT=json \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# --- Operating-system user -------------------------------------------------
# A fixed numeric uid/gid rather than a name, so a bind-mounted volume keeps a
# predictable owner on the host and an orchestrator can enforce the same
# identity in a security context.
RUN addgroup --system --gid 1001 taskflow \
 && adduser --system --uid 1001 --ingroup taskflow --home /home/taskflow taskflow \
 && mkdir -p /var/lib/taskflow \
 && chown -R taskflow:taskflow /var/lib/taskflow /home/taskflow

# --- Application source ----------------------------------------------------
# --chown avoids a separate recursive chown layer, which would duplicate the
# whole source tree in the image.
COPY --chown=taskflow:taskflow package.json VERSION ./
COPY --chown=taskflow:taskflow src ./src
COPY --chown=taskflow:taskflow public ./public
COPY --chown=taskflow:taskflow scripts ./scripts
COPY --chown=taskflow:taskflow docker ./docker

RUN chmod +x docker/entrypoint.sh

USER taskflow

# --- Runtime ---------------------------------------------------------------
# The database lives on a volume so it survives container replacement; see
# docker-compose.yml.
VOLUME ["/var/lib/taskflow"]

EXPOSE 8080

# The liveness endpoint is used, not readiness: a failing liveness check means
# the container should be replaced, which is the correct response to a hung
# process. Readiness is a routing decision and belongs to the orchestrator.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Use the entrypoint so the schema is migrated before the server starts.
ENTRYPOINT ["/app/docker/entrypoint.sh"]

# Default command. Overridable, so `docker run <image> node scripts/migrate.js --status`
# works without a custom entrypoint.
CMD ["node", "src/server.js"]

# Signals are delivered straight to the entrypoint because it `exec`s the
# server, so SIGTERM reaches the process that handles graceful shutdown.
STOPSIGNAL SIGTERM
