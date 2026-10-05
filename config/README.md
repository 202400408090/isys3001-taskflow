# Configuration reference

TaskFlow is configured **entirely through environment variables**. No value that
differs between environments is hard-coded, which is what allows one build
artefact to be promoted from development to staging to production unchanged.

## 1. How a value is resolved

`src/config/index.js` merges four layers. Later layers override earlier ones:

| Order | Layer | Source | Committed? | Purpose |
| --- | --- | --- | --- | --- |
| 1 | Defaults | `DEFAULTS` in `src/config/index.js` | yes | Safe values so a bare `npm start` works |
| 2 | Baseline | `.env` | template only | Machine-independent developer baseline |
| 3 | Profile | `.env.<NODE_ENV>` | template only | Environment-specific overrides |
| 4 | Process env | `docker run -e`, Compose, CI/CD | no | Deployment injection and secrets |

```
defaults  →  .env  →  .env.<NODE_ENV>  →  process environment  →  typed config
 (lowest precedence)                                        (highest precedence)
```

The real `.env` files are listed in `.gitignore`. Only the `*.example` templates
are committed, so the repository documents the full configuration surface while
never storing a secret.

## 2. Which files exist per environment

| Environment | Profile file (committed template) | Developer copy (git-ignored) |
| --- | --- | --- |
| development | `.env.development.example` | `.env.development` |
| test | not required — the test suite passes explicit overrides | — |
| staging | `.env.staging.example` | `.env.staging` |
| production | `.env.production.example` | `.env.production` (usually absent; injected) |

## 3. Variable reference

### Application

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | yes | One of `development`, `test`, `staging`, `production`. Selects the profile file and the validation strictness. |
| `PORT` | `3000` | no | TCP port. Integer 0–65535; `0` binds a random free port. |
| `HOST` | `0.0.0.0` | no | Bind interface. Must stay `0.0.0.0` inside a container. |
| `APP_NAME` | `TaskFlow` | no | Display name in the client and in `GET /api/v1/meta`. |

### Persistence

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `DATABASE_PATH` | `./data/taskflow.development.sqlite` | yes | SQLite file path. `:memory:` gives a throwaway database used by tests. |

### Security

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `API_KEY` | *(empty)* | in staging/production | Shared secret for the `X-API-Key` header on write operations. Empty disables write authentication (development only). Must be ≥ 16 characters in staging and production. |
| `CORS_ORIGINS` | `*` | in staging/production | Comma-separated origin allow list. `*` is rejected in staging and production. |

### Observability

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | no | `debug`, `info`, `warn` or `error`. |
| `LOG_FORMAT` | `pretty`, or `json` in staging/production | no | `pretty` for humans, `json` for the log pipeline. |

### Request handling

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `RATE_LIMIT_WINDOW_MS` | `60000` | no | Sliding-window length for `/api/*`. |
| `RATE_LIMIT_MAX_REQUESTS` | `300` | no | Requests permitted per window per client IP. |
| `TRUSTED_PROXIES` | *(empty)* | behind a proxy | Comma-separated addresses permitted to set `X-Forwarded-For`. Empty means the header is ignored. |
| `BODY_LIMIT` | `64kb` | no | Maximum JSON body size. Accepts `512`, `64kb`, `1mb`, `2gb`. |

#### Why `TRUSTED_PROXIES` is empty by default

`X-Forwarded-For` is a **request header**, so any client can set it. If the
application honours it unconditionally, two things follow:

1. A client that changes one header per request is never rate limited at all,
   because every request lands in a fresh bucket.
2. A client that names somebody else's address spends *that* client's budget, so
   denying service to a specific user costs the attacker nothing.

The header is therefore read only when the immediate peer is on the
`TRUSTED_PROXIES` list — that is, only when the value was appended by
infrastructure the deployment controls — and the chain is read from the
right-hand end, because a client can prepend entries of its own but cannot remove
the one the last trusted hop appended.

Leaving it empty is correct for a direct deployment. It produces one shared
budget across all clients, which is the safe failure mode. Set it only when a
proxy or load balancer genuinely sits in front of the process:

```bash
# Behind a load balancer on the private network
TRUSTED_PROXIES=10.0.0.1,10.0.0.2
```

This behaviour was corrected in **v1.0.1**; before that the header was honoured
unconditionally. See `CHANGELOG.md`.

### Deployment metadata

These three are written by the release pipeline, never by hand, and are exposed
read-only through `GET /api/v1/meta` so a running container can prove which
revision it is serving.

| Variable | Default | Written by |
| --- | --- | --- |
| `APP_VERSION` | `0.0.0` | `docker build --build-arg APP_VERSION=$(git describe --tags)` |
| `GIT_COMMIT` | `unknown` | `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)` |
| `BUILD_TIME` | *(empty)* | `--build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)` |

## 4. Validation rules

`buildConfig()` collects **every** problem and reports them together, so one
run of the process surfaces the whole list rather than one error per attempt.

| Rule | Enforced when |
| --- | --- |
| `NODE_ENV` is one of the four valid names | always |
| `PORT` is an integer in 0–65535 | always |
| `LOG_LEVEL` / `LOG_FORMAT` are known values | always |
| `BODY_LIMIT` matches a size pattern | always |
| `API_KEY` ≥ 16 characters | `staging`, `production` |
| `CORS_ORIGINS` excludes `*` | `staging`, `production` |
| `RATE_LIMIT_*` are within sane bounds | always |

A violation raises `ConfigurationError` and the process exits with status 1
before the HTTP port is opened.

## 5. Common operations

```bash
# Show which files the running configuration came from
NODE_ENV=staging npm start      # the config logger prints the resolved sources

# Prove the failure mode is fail-fast, not fail-at-first-request
NODE_ENV=production API_KEY=short CORS_ORIGINS='*' npm start
# → exits 1 with both problems listed

# Inspect the effective configuration of a running instance
curl -s localhost:3000/api/v1/meta | node -e "process.stdin.pipe(process.stdout)"
```

## 6. Adding a new setting

1. Add it to `DEFAULTS` in `src/config/index.js` with a safe default.
2. Document it in `.env.example` and in the relevant `.env.<env>.example` files.
3. Add it to the table above.
4. If it is secret, add its name to `REDACTED_KEYS` in `src/lib/logger.js` so it
   can never be printed.
5. Add a case to `tests/config.test.js`.
6. Commit with `feat(config):` and reference the variable name.

Following the checklist keeps the committed documentation and the code in step,
which is what makes the repository the single source of truth for configuration.
