#!/bin/sh
# ---------------------------------------------------------------------------
# Container entrypoint.
#
# WHY MIGRATIONS RUN HERE AND NOT IN THE CI PIPELINE
#
# The pipeline cannot reach the production database, and it should not be able
# to: a build stage that holds production credentials is a much larger attack
# surface than a container that already runs there. Running migrations at
# start-up also means the schema always matches the code in the same image, so
# a rollback to a previous image is accompanied by a schema that image expects.
#
# The trade-off is that migrations must be backward compatible for one release,
# because old and new containers can briefly run side by side during a rolling
# deployment. This is why migration 0001 is additive only and why every later
# migration must follow the expand/contract pattern:
#   1. add the new column, nullable, with no default        (this release)
#   2. backfill and start using it                          (a later release)
#   3. drop the old column                                  (a later release)
#
# The script uses `set -e` so that any failure aborts the container rather than
# letting it start against a schema it does not understand.
# ---------------------------------------------------------------------------

set -eu

log() {
  printf '%s [entrypoint] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

log "starting container for NODE_ENV=${NODE_ENV:-unset}"
log "version=${APP_VERSION:-unset} commit=${GIT_COMMIT:-unknown}"

# ---------------------------------------------------------------------------
# Prepare the data directory.
#
# A named volume is created by the engine owned by root, so the unprivileged
# process cannot write to it until the ownership is corrected. The ownership of
# the mount point itself cannot be changed from inside the container without
# privilege, so the check reports the problem clearly instead of failing later
# with an opaque SQLITE_CANTOPEN.
# ---------------------------------------------------------------------------
DATA_DIR="$(dirname "${DATABASE_PATH:-/var/lib/taskflow/taskflow.sqlite}")"

if [ ! -d "$DATA_DIR" ]; then
  log "creating data directory $DATA_DIR"
  mkdir -p "$DATA_DIR" || {
    log "ERROR cannot create $DATA_DIR"
    exit 1
  }
fi

if [ ! -w "$DATA_DIR" ]; then
  log "ERROR $DATA_DIR is not writable by uid $(id -u)"
  log "HINT   the volume is probably owned by root; fix it with:"
  log "       docker run --rm -v taskflow-data:/data alpine chown -R 1001:1001 /data"
  exit 1
fi

# ---------------------------------------------------------------------------
# Apply pending migrations.
#
# `npm run migrate` is deliberately not used: the script is invoked through node
# directly so that no package manager is required in the runtime image.
# ---------------------------------------------------------------------------
log "applying database migrations"
if ! node scripts/migrate.js; then
  log "ERROR migration failed; refusing to start against an unknown schema"
  exit 1
fi

# ---------------------------------------------------------------------------
# Hand over to the container command.
#
# `exec` replaces the shell, so the server becomes PID 1 and receives SIGTERM
# directly. Without it, the shell would receive the signal and the server would
# never run its graceful shutdown handler.
# ---------------------------------------------------------------------------
log "starting: $*"
exec "$@"
