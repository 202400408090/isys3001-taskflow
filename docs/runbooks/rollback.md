# Runbook: roll back a deployment

**When to use this:** a revision is deployed that is worse than the one it
replaced - a failed release, a regression in production, a configuration mistake
that only appears at scale.

**Target time to service restored:** under 5 minutes.

**Guiding principle:** restore service first, diagnose afterwards. The preserved
container and its logs are the evidence; do not destroy them while fixing.

---

## Before you start

Confirm that a rollback is the right action. It is not, if:

- The failure is a **configuration** problem. Fix the variable and restart;
  rolling back the code changes nothing and costs two deployments.
- The failure is a **database** problem that a rollback would worsen, for
  example a migration that partially applied. Go to § 4.
- The new revision is fine and the traffic is simply not reaching it. Check
  readiness before touching the image: `curl -s $BASE/readyz`.

Rollback is the right action when the previous revision demonstrably worked and
the current one does not.

---

## 1. Establish the current and previous revisions

```bash
# What is running now
curl -s "$BASE_URL/api/v1/meta" | node -e "process.stdin.pipe(process.stdout)"
# → {"data":{"environment":"production","revision":{"commit":"a1b2c3d"},...}}

# The recent releases, newest first
git fetch --tags
git tag --list 'v*' --sort=-version:refname | head -5
```

Record both. The commit from `/api/v1/meta` is what you are rolling *back from*,
and it must appear in the incident note.

---

## 2. Find the image for the target revision

```bash
# Images are tagged with both the version and the commit
docker image ls | grep taskflow
# ghcr.io/<owner>/<repo>   1.0.0-a1b2c3d   ...
# ghcr.io/<owner>/<repo>   1.0.0-9f8e7d6   ...     <- the previous release
```

If the platform hosts the registry:

```bash
docker pull ghcr.io/<owner>/<repo>:1.0.0-9f8e7d6
```

Do not rebuild from the source at the target tag. Deploy the image that was
already verified; a rebuild introduces a new variable during an incident.

---

## 3. Roll back

### Docker Compose (single host)

```bash
# Pin the previous image instead of building
APP_VERSION=1.0.0-9f8e7d6 docker compose up --detach

# Confirm
docker compose ps
curl -s http://localhost:3000/readyz
```

### Kubernetes

```bash
kubectl set image deployment/taskflow \
  app=ghcr.io/<owner>/<repo>:1.0.0-9f8e7d6

kubectl rollout status deployment/taskflow --timeout=120s

# If the rollout does not converge, revert to the previous ReplicaSet
kubectl rollout undo deployment/taskflow
```

### Plain Docker

```bash
docker stop taskflow-app && docker rm taskflow-app

docker run --detach --name taskflow-app \
  --publish 8080:8080 \
  --volume taskflow-data:/var/lib/taskflow \
  --env-file /etc/taskflow/production.env \
  ghcr.io/<owner>/<repo>:1.0.0-9f8e7d6
```

---

## 4. If the cause is a migration

Migrations are **forward-only by design** (`src/db/migrate.js` refuses an edited
migration, and `schema_migrations` is a ledger rather than a switch). A rollback
of the image therefore does **not** roll back the schema.

Two cases:

**The migration applied successfully and the new revision has not yet written
data using it.** Rolling the image back is safe, because the added column is
nullable and the previous code does not read it. This is exactly why every
migration must be backward compatible for one release.

**The migration failed, or applied partially.** The runner wraps each migration
in a transaction and rolls back on failure, so a partial application should be
impossible. Verify rather than assume:

```bash
node scripts/migrate.js --status
```

| Result | Meaning | Action |
| --- | --- | --- |
| Every migration `applied` | The schema is consistent | Proceed with the image rollback |
| A migration `pending` | It never ran | Start the container; it will apply at boot |
| A migration `MODIFIED` | An applied file was edited after the fact | **Stop.** Restore the file from the tagged commit and add a new migration instead. Do not edit an applied migration. |

Never make the schema match the old code by editing an applied migration. Correct
it forward with a new one.

---

## 5. Verify the rollback

```bash
SMOKE_BASE_URL=$BASE_URL API_KEY="$API_KEY" node scripts/smoke-test.js
```

All checks must pass. Then confirm the identity explicitly, because "the smoke
test passed" does not prove *which* revision answered:

```bash
curl -s "$BASE_URL/api/v1/meta" | node -e "process.stdin.pipe(process.stdout)"
```

The reported commit must be the target revision. If it is not, the old container
is still serving - check the orchestrator's rollout status, not the application.

---

## 6. Preserve the evidence

Before removing the failed revision:

```bash
# The full log of the failed container, JSON-formatted
docker logs taskflow-app > incident-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1

# The environment it ran with, with secrets masked by the logger already
docker inspect taskflow-app --format '{{json .Config.Env}}'
```

The application logs one JSON object per line carrying `requestId`, so a single
failing request can be traced across the log stream with one grep:

```bash
grep '<request-id-from-the-error-response>' incident-*.log
```

---

## 7. Follow up

1. **Reproduce before fixing.** Create a `hotfix/*` branch from `main`, not from
   `develop`: see `CONTRIBUTING.md` § 1. The fix must contain a test that fails
   without it.
2. **Correct the schema forward** if § 4 applied.
3. **Write the incident note** against the failing commit: symptom, the request
   ids that demonstrated it, the revision that was rolled back, the root cause,
   and the test that now prevents it.
4. **Check whether the pipeline should have caught it.** If the failure was a
   configuration value, the `configuration` job in `.github/workflows/ci.yml` is
   the place to add the check. If it was behavioural, the test suite is.
5. **Release the fix** with `make release VERSION=<next-patch>`.

---

## Reference: what is and is not rolled back

| Rolled back | Not rolled back |
| --- | --- |
| Application code (the image) | The database schema |
| Configuration, if the previous values are restored | Data written by the new revision |
| Log and metric verbosity | Migrations already applied |
| The `APP_VERSION` / `GIT_COMMIT` reported by `/api/v1/meta` | The contents of the data volume |

The asymmetry in that table is the reason for the expand/contract rule in
`docs/deployment.md` § 5: a schema that only ever grows can always be read by the
previous revision, which is what makes an image rollback safe.
