# 0002. Layer configuration by environment

- Status: Accepted
- Date: 2026-08-24
- Deciders: project developer
- Related: `src/config/index.js`, `config/README.md`, `docs/deployment.md`

## Context

The application must run in four situations: a developer's laptop, the test
suite, a staging deployment and a production deployment. The values that differ
between those situations include the TCP port, the database path, the verbosity
and format of logging, the list of browser origins permitted to call the API,
and the shared secret that authorises write operations.

Three broad approaches were available.

1. **One configuration file per environment, each a complete copy.** Simple to
   read, but the copies drift. A setting added to the development file is
   frequently forgotten in the production file, and the omission is discovered
   at deploy time or, worse, in production.
2. **A single file with a switch on the environment name inside the code.** Every
   change to a setting requires a code change and therefore a new release
   candidate, which contradicts the point of separating configuration from code.
   It also places secrets one careless commit away from the repository.
3. **Externalised, layered environment variables.** The twelve-factor approach:
   configuration lives in the environment, code is identical across
   environments, and no secret is ever committed.

## Decision

Configuration is externalised into environment variables and resolved from four
ordered layers, with later layers overriding earlier ones:

```
defaults  →  .env  →  .env.<NODE_ENV>  →  process environment
```

1. **Defaults** live in `DEFAULTS` inside `src/config/index.js` so that a bare
   `npm start` works on a clean checkout.
2. **`.env`** carries the baseline that is true on any machine.
3. **`.env.<NODE_ENV>`** carries the environment profile.
4. **The process environment** is applied last, because that is how Docker,
   Docker Compose and GitHub Actions inject values. A value supplied this way
   always beats a file, including a file accidentally baked into an image.

Only the `*.example` templates are committed. The real files are git-ignored.

The loader validates and normalises every value in one place, collecting all
problems rather than stopping at the first, and throws `ConfigurationError` so
the process exits non-zero **before** binding the port.

## Consequences

**Easier**

- One container image is promoted from staging to production unchanged. Only the
  environment differs, so "it worked in staging" is a meaningful statement.
- Configuration becomes declarative and reviewable: a change to a limit is a
  diff in a committed template, visible in `git log`.
- Secrets stay out of the repository. The templates name the variable and
  describe its constraints but never carry a real value.
- Misconfiguration fails fast and loudly at start-up, so an unhealthy instance
  never accepts traffic.

**Harder / must be maintained**

- The `.example` templates and `config/README.md` must be updated whenever a
  setting is added. The checklist in `config/README.md` § 6 exists to enforce it.
- Layer precedence is implicit and can surprise a reader, so the resolved source
  files are logged at start-up and `GET /api/v1/meta` reports the effective
  environment and revision.
- Validation rules are duplicated between implementation and tests, so a rule
  change requires a test change. This is accepted as the price of having the
  rules executable rather than prose-only.
