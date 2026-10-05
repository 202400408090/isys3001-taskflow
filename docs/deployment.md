# Deployment configuration

This document describes how TaskFlow is configured, built, deployed, verified and
rolled back. It is the operational counterpart to `config/README.md`: that file
says what each setting means, this one says how a setting reaches a deployment.

---

## 1. The deployment model

One **immutable image** is promoted through **development → staging →
production**. The image is never rebuilt for a different environment, because
configuration is external to it. That is the entire point of the layered
configuration described in [ADR-0002](adr/0002-layered-environment-configuration.md):
if the same bytes work in staging they will work in production, and "it worked in
staging" becomes a meaningful statement.

```
             build once                    promote unchanged
source ──▶ image:1.0.0-a1b2c3d ──┬──▶ staging      (env vars from the staging secret store)
                                  └──▶ production   (env vars from the production secret store)
```

| Concern | Where it lives | Committed? |
| --- | --- | --- |
| Application code | `src/`, `public/` | yes |
| The image recipe | `Dockerfile`, `.dockerignore` | yes |
| Compose topology | `docker-compose.yml` | yes |
| Configuration defaults | `src/config/index.js` (`DEFAULTS`) | yes |
| Configuration surface | `.env*.example`, `config/README.md` | yes |
| Environment values | the platform's environment | no |
| Secrets | the platform's secret store | no |
| Database | a named volume, migrated on start | no |

---

## 2. Environment variables that must be supplied

Everything else has a working default. These four must be set explicitly for a
staging or production deployment, and the process refuses to start without them.

| Variable | Constraint | Why it is mandatory |
| --- | --- | --- |
| `NODE_ENV` | `staging` or `production` | Enables the strict validation rules and JSON logging |
| `API_KEY` | ≥ 16 characters | Without it, every write endpoint is unauthenticated |
| `CORS_ORIGINS` | a list, no `*` | A wildcard would let any origin call the API from a browser |
| `DATABASE_PATH` | a writable path | The default is a development path that does not exist in the image |

Inject them from the platform's secret store, never from a committed file:

```bash
# Docker Compose: read from the shell environment, which the operator exports
docker compose run --env API_KEY="$PROD_API_KEY" app

# Kubernetes: a Secret projected into the environment
kubectl create secret generic taskflow-secrets \
  --from-literal=API_KEY="$PROD_API_KEY"
```

---

## 3. Building the image

Always through the script, never by hand. The script passes the build metadata
that makes a running container identifiable, and it marks a build from a dirty
working tree with a `-dirty` suffix so it can never be mistaken for a tagged
revision.

```bash
node scripts/build-image.js                    # tag from VERSION and git
node scripts/build-image.js --print            # show the exact docker command
node scripts/build-image.js --tag registry.example.edu/taskflow:1.0.0
make docker-build                              # the same thing
```

Build arguments and what they become:

| Argument | Becomes | Read by |
| --- | --- | --- |
| `APP_VERSION` | `ENV APP_VERSION` | `GET /api/v1/meta`, log lines, the client header |
| `GIT_COMMIT` | `ENV GIT_COMMIT` | `GET /api/v1/meta`, `/readyz` |
| `BUILD_TIME` | `ENV BUILD_TIME` | `GET /api/v1/meta` |
| `NODE_ENV` | `ENV NODE_ENV` | the configuration loader |

Verify the identity of a running container from outside it:

```bash
curl -s http://localhost:3000/api/v1/meta | node -e "process.stdin.pipe(process.stdout)"
# {"data":{"environment":"production","revision":{"commit":"a1b2c3d",...}}}
```

This is the answer to "which revision is deployed?" without shell access to the
host, which is the question that costs the most time during an incident.

---

## 4. Local deployment with Docker Compose

```bash
cp .env.example .env          # review it; the defaults are for development
make docker-up                # builds, starts, and waits for /readyz
open http://localhost:3000
make docker-logs              # follow the logs
make docker-down              # stop, keeping the database volume
make docker-clean             # stop and delete the database volume
```

What the Compose file configures, and why each choice was made:

| Setting | Value | Reason |
| --- | --- | --- |
| `read_only: true` | on | The server writes no state to its own filesystem, so the container filesystem can be immutable. This removes a whole class of persistence bug and prevents a compromised process from rewriting its own code. |
| `tmpfs: /tmp` | 16 MB | A read-only root filesystem still needs somewhere writable for the Node.js runtime. |
| `no-new-privileges` | on | Prevents a process inside the container from gaining privilege through a setuid binary. |
| Named volume | `taskflow-data` | The database is environment state that must outlive container replacement, and a named volume needs no host directory with the right ownership. |
| `deploy.resources.limits` | 1 CPU, 256 MB | Bounds what a runaway process can take from the host. |
| `logging.max-size` | 10 MB × 3 | Prevents an unattended stack from filling the disk with logs. |
| Health check | `/readyz` | Compose restarts an instance that cannot serve, not merely one whose process is alive. |
| `restart: unless-stopped` | on | Survives a host reboot without manual intervention. |

---

## 5. What happens when a container starts

`docker/entrypoint.sh` runs before the server, in this order:

1. **Report identity.** Log `NODE_ENV`, `APP_VERSION` and `GIT_COMMIT` so the
   first lines of a container log say what is running.
2. **Prepare the data directory.** A named volume is created owned by root while
   the process runs as uid 1001, so ownership is checked and the failure is
   reported with the exact remedy rather than as an opaque `SQLITE_CANTOPEN`.
3. **Apply migrations.** `node scripts/migrate.js` brings the schema up to date.
   A failure aborts the container instead of starting against an unknown schema.
4. **`exec` the command.** `exec` replaces the shell, so the server is PID 1 and
   receives `SIGTERM` directly - which is what allows the graceful shutdown
   handler in `src/server.js` to drain in-flight requests.

### The migration constraint this creates

Because migrations run at start-up, a rolling deployment briefly has old and new
containers running against the same database. **Every migration must therefore
be backward compatible for one release**, using the expand/contract pattern:

| Release | Schema change | Code |
| --- | --- | --- |
| N | add the new column, nullable, no default | writes both old and new columns |
| N+1 | backfill, add the constraint | reads and writes the new column only |
| N+2 | drop the old column | has no knowledge of it |

`0001_init.sql` is additive only, so it satisfies this already.

---

## 6. Release procedure

The sequence is automated by `scripts/release.js` because two of its seven steps
are routinely forgotten: merging back to `develop`, and regenerating the
changelog before the tag rather than after.

```bash
make release:plan VERSION=1.1.0   # see what a release would contain
make release VERSION=1.1.0        # run the whole sequence
```

What `make release` does:

| # | Step | Why it cannot be omitted |
| --- | --- | --- |
| 1 | branch `release/1.1.0` from `develop` | Isolates stabilisation from new work |
| 2 | write `VERSION` and `package.json` | One version, two files, no drift |
| 3 | regenerate `CHANGELOG.md` | The document is derived from the history, never recalled |
| 4 | run the full test suite | A tag that does not pass its own tests is not a release |
| 5 | merge `--no-ff` into `main` and tag it `v1.1.0` | The tag records the exact commit that was verified |
| 6 | merge `--no-ff` back into `develop` | Without this, the next release silently reverts the version bump |
| 7 | delete the release branch | Keeps `git branch` usable as a to-do list |

Then publish:

```bash
git push origin main develop
git push origin v1.1.0        # the tag that triggers the pipeline
```

The pipeline's `publish` job runs only for `main` or a `v*` tag, and only after
every check has passed. It pushes two immutable tags: the version, and the
version with the commit SHA appended.

---

## 7. Verification after deployment

```bash
SMOKE_BASE_URL=https://staging.example.edu \
API_KEY="$STAGING_API_KEY" \
  node scripts/smoke-test.js
```

Nine checks run, in increasing order of intrusiveness:

| Check | Proves |
| --- | --- |
| `GET /healthz` | The process is alive and reports a version and environment |
| `GET /readyz` | The database answers the readiness query and the commit is reported |
| `GET /api/v1/meta` | The instance can identify the revision it was built from |
| `GET /api/v1/tasks` | The read path returns a paginated list |
| `GET /` | The single-page client is served |
| `GET /assets/app.js` | Static assets carry the correct content type |
| `GET /api/v1/unknown` | Routing returns a JSON 404 in the standard envelope |
| `POST` an invalid task | The write path is reachable **and** defended |
| `POST` + `DELETE` with a key | The authenticated write path works end to end |

The script exits non-zero on any failure, so the pipeline can gate on it and an
operator can use it as the definition of "the deployment succeeded".

---

## 8. Rollback

The full procedure is in [`docs/runbooks/rollback.md`](runbooks/rollback.md).
The short version:

```bash
git tag --list 'v*' --sort=-version:refname | head -5    # find the previous version
kubectl set image deployment/taskflow app=ghcr.io/<owner>/<repo>:<previous-version>
kubectl rollout status deployment/taskflow
```

Because images are immutable and tagged with the commit, a rollback replaces the
running revision exactly, with no rebuild and no re-configuration. The schema is
**not** rolled back: migrations are forward-only, which is why they must be
backward compatible for one release.

---

## 9. Configuration management practices applied in this deployment

| Practice | Where it is implemented |
| --- | --- |
| Configuration externalised from code | `src/config/index.js`, `.env*.example` |
| Layered precedence with a documented order | `config/README.md` § 1, ADR-0002 |
| Validation at start-up, failing fast | `buildConfig()`, `config/README.md` § 4 |
| Secrets never committed | `.gitignore`, `.dockerignore`, `scripts/validate-env.js` |
| Secrets never logged | `REDACTED_KEYS` in `src/lib/logger.js` |
| One artefact promoted between environments | `Dockerfile`, `docker-compose.yml` |
| Build metadata traceable to a commit | `scripts/build-image.js`, `GET /api/v1/meta` |
| Schema version controlled and forward-only | `src/db/migrations/`, `src/db/migrate.js` |
| Immutable infrastructure where possible | `read_only: true` in `docker-compose.yml` |
| Deployment verified, not assumed | `scripts/smoke-test.js`, the `container` job in CI |
| Rollback is a documented, tested procedure | `docs/runbooks/rollback.md` |
| Every change reviewed and traceable | Git Flow + Conventional Commits, `CONTRIBUTING.md` |
