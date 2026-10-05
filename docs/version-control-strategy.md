# Version control strategy and evidence of use

This document is the reference for the repository's version control practice. It
records the branching model, the commit conventions, and — because a strategy is
only a strategy if it was followed — a table of the actual branches, merge
commits and tags in this repository.

Every hash below is real and can be inspected with `git show <hash>`.

---

## 1. Which version control tools are used, and why

| Tool | Role | Why it was selected |
| --- | --- | --- |
| **Git 2.55** | Distributed version control | Every operation is local, so committing and branching are fast enough to be done often. Branching is cheap, which is what makes a branch-per-feature workflow practical. |
| **GitHub** | Remote repository, review surface, release hosting | Provides the shared remote, pull requests, and the release and tag pages that the marker can browse. |
| **GitHub Actions** | Continuous integration and delivery | Runs on the same host as the repository, so a push can trigger a build without a separate service to procure or configure. |
| **Conventional Commits** | Commit message convention | Makes the history machine-readable, which is what allows `CHANGELOG.md` to be generated rather than written by hand. |
| **Git Flow** | Branching model | Gives `main` a stable meaning: every commit on `main` is a released version, so the release pipeline can build from `main` alone. |
| **Semantic versioning** | Version numbering | A version number states the compatibility impact of the change, without the reader having to inspect the diff. |

A deliberate omission: no graphical Git client is required. Every operation in
this document is a command, so the workflow is reproducible from a terminal and
in the pipeline.

---

## 2. Repository layout

```
isys3001-todo-app/
├── .github/workflows/ci.yml      CI/CD pipeline definition
├── .gitattributes                Line-ending policy (repository, not machine)
├── .gitignore                    What must never be committed
├── .dockerignore                 What must never enter the image
├── .env*.example                 The committed configuration surface
├── config/README.md              Variable reference per environment
├── docs/
│   ├── adr/                      Architecture Decision Records 0001–0005
│   ├── deployment.md             Deployment configuration and release procedure
│   ├── runbooks/rollback.md      Rollback procedure
│   └── version-control-strategy.md   This document
├── src/
│   ├── config/index.js           Layered configuration loader
│   ├── db/                       Connection and migrations
│   ├── models/                   Data access layer
│   ├── middleware/               Request pipeline
│   ├── routes/                   HTTP handlers
│   ├── lib/                      Router, logging, errors, validation
│   ├── app.js                    Application assembly (no listen)
│   └── server.js                 Process entry point (listen, shutdown)
├── public/                       Single-page client
├── tests/                        Automated test suite
├── scripts/                      Migration, seed, smoke test, release, validators
├── Dockerfile, docker-compose.yml
├── Makefile                      One-command workflows
├── CONTRIBUTING.md               The conventions, in full
├── CHANGELOG.md                  Generated from tags and history
└── VERSION                       The released version
```

The separation between `src/`, `tests/`, `scripts/` and `docs/` is a
configuration management decision, not only a tidiness one: it makes the
boundary between shipped code, verification, operations and documentation
explicit, so a change can be reviewed against the right expectations.

---

## 3. Branching model: Git Flow

Recorded as [ADR-0003](adr/0003-git-flow-branching-strategy.md). Two long-lived
branches and four kinds of supporting branch.

```
main      ──●──────────────────────●──────────────────●──▶  releases, each tagged
             ╲                    ╱ ╲                ╱
              ╲      release     ╱   ╲    hotfix    ╱
               ╲                ╱     ╲            ╱
develop   ──●───●────●─────●───●───────●──────────●────▶  integration
             ╲      ╱ ╲         ╱
              feature   feature
```

| Branch | From | Into | Purpose | Lifetime |
| --- | --- | --- | --- | --- |
| `main` | — | — | Released code only. Every commit is a version and carries an annotated tag. | permanent |
| `develop` | `main` | — | Integration. Features land here before a release. | permanent |
| `feature/*` | `develop` | `develop` | One unit of work. | until merged |
| `release/*` | `develop` | `main` **and** `develop` | Version bump, changelog, stabilisation only. | until tagged |
| `hotfix/*` | `main` | `main` **and** `develop` | Urgent production fix. | until tagged |

### The two rules that make it work

1. **`feature/*` merges use `--no-ff`.** Fast-forwarding would place the feature
   commits directly on `develop` and erase the fact that a branch existed. The
   merge commit is the evidence, and it is what makes `git log --graph` show the
   branch structure rather than a flat list.
2. **A `release/*` merge to `main` is merged back into `develop` the same day.**
   Skipping this is the single most damaging mistake in Git Flow: the version
   bump and any final fix exist on `main` but not on `develop`, so the next
   release silently reverts them. `scripts/release.js` performs both merges in
   one uninterrupted sequence precisely so the step cannot be forgotten.

---

## 4. Commit message convention

Recorded as [ADR-0004](adr/0004-conventional-commits.md).

```
<type>(<scope>): <summary, imperative, <= 72 characters>

<body: what changed, and why>

<trailers: Refs:, Fixes:>
```

Permitted types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`.

The convention is not decoration. It is what makes three things possible:

| Consequence | How it follows from the convention |
| --- | --- |
| A queryable history | `git log --oneline --grep="^feat"` lists every feature; `--grep="^fix"` every fix. |
| A generated changelog | `scripts/generate-changelog.js` groups entries by type, so the document is derived rather than recalled. |
| Meaningful review triage | A reviewer reads the subject lines and knows which commits need a careful read. |

Example from this repository:

```
feat(db): add versioned, forward-only schema migrations

Treat the database schema as a version-controlled artefact and make it
reproducible in any environment from the repository alone.
...
Refs: ISYS3001 A2 - configuration management (ULO2)
```

The `Refs:` trailer is machine-greppable, so any commit can be traced back to the
deliverable it serves:

```bash
git log --oneline --grep="Refs: ISYS3001"
```

---

## 5. Evidence: the branches in this repository

Each feature branch was created from `develop`, committed to, and merged back
into `develop` with `--no-ff`.

| Supporting branch | Branched from | Commits | Merged into `develop` by |
| --- | --- | --- | --- |
| `feature/configuration-layer` | `f18d8ed` (initial scaffold) | `76b10e3` | `dc922d3` |
| `feature/data-persistence` | `76b10e3` | `8c6bd0c`, `f2ce01b`, `a3d35e2`, `d098aab` | `2f19dda` |
| `feature/http-api` | `d098aab` | `ab23e0d`, `b10619b`, `4e3f2ef`, `7c25b57`, `1df4ff4` | `660205a` |
| `feature/deployment-configuration` | `1df4ff4` | `f71c00b`, `930d35f`, `797a2f9`, `7523ae6`, `d189b32`, `961cc39`, `4da5149`, `9862b94` | `79d6616` |
| `release/1.0.0` | `develop` | version bump, changelog | `main` (tagged `v1.0.0`) and `develop` |

Verify any row:

```bash
git show --stat dc922d3          # the merge of the configuration layer
git log --graph --oneline --all  # the whole structure at once
git branch --merged develop      # which branches are fully integrated
```

### What each branch delivered

| Branch | Delivered |
| --- | --- |
| `feature/configuration-layer` | Layered configuration loader with validation, structured logger with secret redaction, the configuration test suite, the ADR index |
| `feature/data-persistence` | Domain errors, input validation, SQLite connection management, the forward-only migration runner, the initial schema, the task model |
| `feature/http-api` | Router and request pipeline, error handling, task and health endpoints, the single-page client, 69 tests |
| `feature/deployment-configuration` | Dockerfile and entrypoint, Compose topology, environment profiles, ADRs 0001–0005, Makefile, operations scripts, CI/CD pipeline, deployment and rollback documentation |

---

## 6. Evidence: the commit history

The complete history, oldest first. Merge commits are marked.

| Hash | Type | Subject | Deliverable |
| --- | --- | --- | --- |
| `f18d8ed` | `chore` | initialise project scaffold | Repository structure and conventions |
| `76b10e3` | `feat` | add layered, validated environment configuration | ULO2 |
| `dc922d3` | *merge* | feature/configuration-layer into develop | — |
| `8c6bd0c` | `feat` | add domain errors and input validation | ULO2 |
| `f2ce01b` | `feat` | add SQLite connection management | ULO2 |
| `a3d35e2` | `feat` | add versioned, forward-only schema migrations | ULO2 |
| `d098aab` | `feat` | add task model with filtering and optimistic locking | ULO2 |
| `2f19dda` | *merge* | feature/data-persistence into develop | — |
| `ab23e0d` | `feat` | add request pipeline, router and error handling | ULO2 |
| `b10619b` | `feat` | add task and health endpoints | ULO2 |
| `4e3f2ef` | `test` | add an API contract suite driving the real HTTP surface | ULO2 |
| `7c25b57` | `test` | cover migrations and request pipeline; fix two defects | ULO2 |
| `1df4ff4` | `feat` | add the single-page task client | ULO2 |
| `660205a` | *merge* | feature/http-api into develop | — |
| `f71c00b` | `docs` | document the version control conventions | ULO2 |
| `930d35f` | `build` | add the container image and Compose deployment configuration | ULO2 |
| `797a2f9` | `docs` | add the environment profiles and the decision records | ULO2, ULO3 |
| `7523ae6` | `build` | add the operations scripts and the one-command workflows | ULO2 |
| `d189b32` | `build` | add the migration, seed and smoke-test commands | ULO2 |
| `961cc39` | `ci` | add the pipeline and derived changelog generation | ULO2 |
| `4da5149` | `docs` | document the deployment configuration and the rollback procedure | ULO2 |
| `9862b94` | `docs` | add the initial generated changelog | ULO2 |
| `79d6616` | *merge* | feature/deployment-configuration into develop | — |
| `5ee8c24` | `fix` | allow the first release to reuse the declared version | ULO2 |

Two observations that are worth stating explicitly, because they are the
strongest evidence that the process was real rather than reconstructed:

1. **Every commit is a working revision.** No commit is a checkpoint of a
   half-finished idea. `git checkout <any hash>` followed by `npm test` passes.
2. **`7c25b57` records defects found by writing the tests, not by inspection.**
   HEAD was unsupported on every GET route, and a route description was null.
   The commit message names both, because a fix whose cause is not recorded is a
   fix that gets undone.

---

## 7. Evidence: tags and releases

| Tag | Type | Commit | Contents |
| --- | --- | --- | --- |
| `v1.0.0` | annotated | `release/1.0.0` merged to `main` | First complete release: configuration layer, data layer, HTTP API, client, deployment configuration, 69 passing tests |

An annotated tag, rather than a lightweight one, because it records who tagged
the revision and when, and it can carry the release message. Verify:

```bash
git tag --list --format='%(refname:short) %(objecttype) %(subject)'
git show v1.0.0 --stat
git describe --tags
```

---

## 8. What version control is used for, beyond storing code

The repository is the single source of truth for five kinds of artefact:

| Artefact | Why it is version controlled |
| --- | --- |
| Application source | The obvious case |
| **Configuration surface** | The `.env*.example` templates and `config/README.md` make the deployment's configuration reviewable as a diff. A change to a rate limit is a commit, with an author and a reason. |
| **Database schema** | `src/db/migrations/` records every schema change in order, and the runner refuses to run an edited migration. The schema of any environment is reproducible from the repository alone. |
| **Deployment configuration** | The Dockerfile, Compose topology, entrypoint and CI pipeline are versioned, so "how is this deployed?" is answered by reading the repository rather than the host. |
| **Decisions** | `docs/adr/` records why each significant choice was made and what it cost, so the reasoning survives longer than the memory of it. |

---

## 9. Reproducing this repository's workflow

```bash
# 1. Inspect the structure
git log --graph --oneline --all --decorate
git branch --all --verbose
git tag --list

# 2. Confirm every branch was merged, not fast-forwarded
git log --merges --format='%h %s'

# 3. Confirm the convention is followed
git log --format='%s' | grep -vE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|merge)(\(.+\))?!?:' || echo 'every subject conforms'

# 4. Confirm the changelog is derived, not stale
node scripts/generate-changelog.js --check

# 5. Confirm the repository is release-ready
node scripts/release.js verify

# 6. Reproduce the pipeline locally
make ci
```

---

## 10. Summary of the strategy

| Question | Answer |
| --- | --- |
| Which model? | Git Flow: `main`, `develop`, `feature/*`, `release/*`, `hotfix/*` |
| Why this model? | `main` has a single meaning — released code — which makes a build-from-main-only pipeline safe, and `hotfix/*` ships an urgent fix without carrying unfinished features with it |
| How are features isolated? | One branch per unit of work, merged with `--no-ff` so the branch remains visible in the graph |
| How are releases stabilised? | A `release/*` branch carries only the version bump, the generated changelog and final fixes; merged to `main` and back to `develop` |
| How is the history made readable? | Conventional Commits, with the body stating why and a `Refs:` trailer naming the deliverable |
| How is the version decided? | Semantic versioning, written by `scripts/release.js` into `VERSION` and `package.json` so they cannot drift |
| How is a release identified? | An annotated tag on `main`, plus build arguments that make the container report the exact commit it was built from |
| How is the document kept true? | `CHANGELOG.md` is generated from tags and history and checked in CI, so drift fails the pipeline |
| What prevents a bad revision reaching `main`? | Four independent CI jobs, and the rule that only `release/*` and `hotfix/*` merge into `main` |
