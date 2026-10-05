# TaskFlow

TaskFlow is a small task-management web application developed for the
**ISYS3001 – Managing Software Development** software development project.

The application is deliberately small in feature scope so that the assessment
focus stays where the unit puts it: **configuration management** (version
control, branching, environment configuration, deployment configuration) and
**procurement management** (tool and service selection, RFP).

---

## 1. What the application does

A single-page web client backed by a JSON HTTP API.

| Capability | Description |
| --- | --- |
| Create | Add a task with a title, optional description, priority and optional due date |
| Read | List tasks with filtering (`status`, `priority`, `search`) and pagination |
| Update | Edit any field of a task, including completion status |
| Delete | Remove a task |
| Health | `GET /healthz` for liveness, `GET /readyz` for readiness (used by the container orchestrator) |

---

## 2. Technology stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | Single language across the stack; long-term support |
| HTTP server | `node:http` (standard library) | Zero external runtime dependencies ⇒ reproducible builds |
| Persistence | `node:sqlite` (standard library) | Embedded SQL database; no separately procured DBMS for a small app |
| Front end | Vanilla HTML/CSS/JS | Avoids a build step in the deployment pipeline |
| Tests | `node:test` (standard library) | Built-in test runner and coverage reporting |
| Packaging | Docker (multi-stage) | Identical artefact across dev / staging / production |
| CI/CD | GitHub Actions | Integrated with the version control host |

> **Design note for the procurement report.** Every dependency choice above was
> made so that the runtime dependency graph is empty. This removes the largest
> recurring procurement risk in a student project (transitive dependency
> licensing and CVE exposure) and keeps the attack surface of the deployment
> image small.

---

## 3. Repository layout

```
.
├── .github/workflows/          CI/CD pipeline definitions
├── .vscode/                    Shared editor settings
├── config/                     Human-readable configuration reference
├── docker/                     Container-specific helper files
├── docs/                       Project documentation
│   ├── adr/                    Architecture Decision Records
│   └── runbooks/               Operational runbooks
├── scripts/                    Operational helper scripts
├── src/
│   ├── config/                 Configuration loader (env → typed config)
│   ├── db/                     Connection, migrations, migration SQL
│   ├── models/                 Data access layer (one module per entity)
│   ├── middleware/             Cross-cutting HTTP middleware
│   ├── routes/                 HTTP route handlers
│   ├── lib/                    Small shared utilities
│   ├── app.js                  Application assembly (testable, no listen)
│   └── server.js               Process entry point (listen + shutdown)
├── public/                     Static single-page client
├── tests/                      Automated test suite
├── .dockerignore
├── .editorconfig
├── .env.example                Template for a developer's local .env
├── .env.development.example    Development environment profile
├── .env.staging.example        Staging environment profile
├── .env.production.example     Production environment profile
├── CHANGELOG.md                Generated from the Git history
├── CONTRIBUTING.md             Branching and commit conventions
├── Dockerfile                  Multi-stage production image
├── docker-compose.yml          Local multi-container environment
├── Makefile                    One-command developer workflows
└── VERSION                     Current release version
```

---

## 4. Quick start (local development)

Prerequisites: **Node.js 24+** and **Git**.

```bash
git clone <your-repository-url> isys3001-todo-app
cd isys3001-todo-app
cp .env.example .env
npm run migrate     # create the SQLite schema
npm run seed        # optional: insert sample tasks
npm start           # http://localhost:3000
```

Run the tests:

```bash
npm test
```

---

## 5. Running with Docker

```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f app
# http://localhost:3000/healthz
docker compose down
```

---

## 6. Configuration

All runtime configuration is supplied through environment variables and is
validated at start-up. An invalid or missing required value causes the process
to exit with a non-zero status **before** it accepts traffic, which prevents a
misconfigured instance from being marked healthy by a load balancer.

See [`config/README.md`](config/README.md) for the full variable reference and
[`docs/adr/0002-layered-environment-configuration.md`](docs/adr/0002-layered-environment-configuration.md)
for the reasoning behind the layered approach.

---

## 7. Version control workflow

This repository follows **Git Flow**:

| Branch | Purpose |
| --- | --- |
| `main` | Production-ready code; every commit is a released version and is tagged |
| `develop` | Integration branch for completed features |
| `feature/*` | One branch per feature, branched from `develop` |
| `release/*` | Release stabilisation, branched from `develop`, merged to `main` **and** `develop` |
| `hotfix/*` | Urgent production fix, branched from `main` |

Commit messages follow **Conventional Commits**. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the full conventions.

---

## 8. Documentation map

| Document | Content |
| --- | --- |
| `CONTRIBUTING.md` | Branching model, commit convention, review checklist |
| `CHANGELOG.md` | Release history generated from Git tags |
| `config/README.md` | Configuration variable reference per environment |
| `docs/deployment.md` | Deployment configuration and release procedure |
| `docs/version-control-strategy.md` | Branching strategy and evidence of use |
| `docs/runbooks/rollback.md` | Rollback procedure |
| `docs/adr/` | Architecture Decision Records |

---

## 9. Licence

MIT — see [`LICENSE`](LICENSE).
