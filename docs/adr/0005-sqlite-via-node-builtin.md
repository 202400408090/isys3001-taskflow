# 0005. Reach the database through `node:sqlite`

- Status: Accepted
- Date: 2026-08-24
- Deciders: project developer
- Related: `src/db/connection.js`, `docs/runbooks/rollback.md`

## Context

The application needs a small persistent store for tasks. It runs on one Node.js
process in a container, holds one table, and serves a single user at a time.

Options considered:

1. **A hosted managed database** (for example a managed PostgreSQL instance).
   Correct for scale, but it introduces a monthly cost, a network dependency, a
   credential to manage and a procurement line item that must be justified
   against a workload that does not need it.
2. **A third-party SQLite driver** such as `better-sqlite3`. Well established and
   fast, but it is a native addon: installing it requires a compiler toolchain,
   the container image must build it for the target architecture, and it must be
   tracked for CVEs and licence obligations like any other dependency.
3. **`node:sqlite`**, the SQLite binding included in the Node.js standard
   library since Node.js 22.

## Decision

Use **`node:sqlite`** behind a thin data access layer
(`src/db/connection.js` plus `src/models/task.model.js`).

The binding is reached only through those two modules. No route handler imports
the driver, and no SQL is written outside `src/models/`. Replacing the store
later therefore means rewriting one module, not the application.

## Consequences

**Easier**

- **Zero runtime dependencies.** The runtime dependency graph is empty, so there
  is no third-party code to track for CVEs, no licence inventory to maintain and
  no supply-chain surface beyond the Node.js runtime itself.
- **No native build step.** The container image installs nothing, which removes
  the compiler toolchain from the build stage and makes builds more reproducible
  and much faster.
- **The store is a file.** Backup is copying one file; the test suite runs
  against `:memory:` with no fixture infrastructure.
- SQL is written explicitly, which keeps the queries reviewable and removes an
  ORM from the dependency graph and from the learning surface.

**Harder / must be maintained**

- `node:sqlite` is a newer module than the mature third-party drivers, so its
  API may still change between major Node.js versions. The Node.js baseline is
  therefore pinned in `package.json` under `engines` and in the `Dockerfile` and
  the CI workflow.
- It exposes a synchronous API. That is a real limitation: a slow query blocks
  the event loop. It is acceptable at this scale and is recorded here as the
  known ceiling of the decision, together with the migration path — swap
  `src/models/task.model.js` for an asynchronous repository backed by a client
  server database.
- SQLite serialises writers. Concurrency beyond a handful of simultaneous
  writers will require WAL tuning (already enabled in `src/db/connection.js`) and
  then migration away.
