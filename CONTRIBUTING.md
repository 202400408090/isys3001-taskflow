# Contributing and version control conventions

This document is the contract every commit in this repository follows. It is the
written form of [ADR-0003](docs/adr/0003-git-flow-branching-strategy.md) and
[ADR-0004](docs/adr/0004-conventional-commits.md).

---

## 1. Branching model

The repository follows **Git Flow**: two long-lived branches and four kinds of
supporting branch.

```
main      ──●────────────────●──────────────●──────────────●──▶  releases (tagged)
             ╲              ╱ ╲            ╱ ╲            ╱
              ╲   hotfix   ╱   ╲  release ╱   ╲  release ╱
               ╲          ╱     ╲        ╱     ╲        ╱
develop   ──●───●────●───●───────●──────●───────●──────●────▶  integration
             ╲      ╱ ╲      ╱
              feature   feature
```

| Branch | Branches from | Merges into | Naming | Purpose |
| --- | --- | --- | --- | --- |
| `main` | — | — | `main` | Production-ready code. Every commit is a released version and carries an annotated tag. The release pipeline builds from here only. |
| `develop` | `main` | — | `develop` | Integration branch. Features land here first. |
| `feature/*` | `develop` | `develop` | `feature/<area>-<short-description>` | One branch per unit of work. |
| `release/*` | `develop` | `main` **and** `develop` | `release/<version>` | Version bump, changelog, final stabilisation only. No new features. |
| `hotfix/*` | `main` | `main` **and** `develop` | `hotfix/<version>` | Urgent production fix. |

### Rules

1. **`main` is always releasable.** Nothing is committed to `main` directly; it
   only ever receives merges from `release/*` or `hotfix/*`.
2. **Features merge with `--no-ff`.** The merge commit is what keeps a feature
   visible as a unit in `git log --graph`, which is the evidence that the
   branching strategy was actually used rather than merely documented.
3. **A `release/*` branch carries no new functionality.** Version bump,
   `CHANGELOG.md`, and defect fixes found while stabilising. A new feature
   discovered mid-release goes to `develop` and waits for the next release.
4. **Every `release/*` and `hotfix/*` merge to `main` is merged back to
   `develop` on the same day.** Skipping this silently reverts the change at the
   next release, and it is the single most common mistake in this model.
5. **Every release on `main` is annotated and tagged** `v<major>.<minor>.<patch>`
   following semantic versioning.
6. **Delete a supporting branch once it is merged.** A merged branch that
   lingers makes `git branch` useless as a to-do list.

### Day-to-day commands

```bash
# Start a feature
git switch develop && git pull
git switch --create feature/procurement-export

# ... work, committing as you go ...

# Finish a feature
git switch develop
git merge --no-ff feature/procurement-export -m "merge: feature/procurement-export"
git branch --delete feature/procurement-export

# Cut a release
git switch develop
git switch --create release/1.1.0
#   bump VERSION and package.json, run `make changelog`, commit
git switch main
git merge --no-ff release/1.1.0 -m "release: 1.1.0"
git tag --annotate v1.1.0 --message "Release 1.1.0"
git switch develop
git merge --no-ff release/1.1.0 -m "merge: release/1.1.0 back into develop"
git branch --delete release/1.1.0

# Ship an urgent production fix
git switch main
git switch --create hotfix/1.0.1
#   fix, test, bump the patch version
git switch main
git merge --no-ff hotfix/1.0.1 -m "hotfix: 1.0.1"
git tag --annotate v1.0.1 --message "Hotfix 1.0.1"
git switch develop
git merge --no-ff hotfix/1.0.1 -m "merge: hotfix/1.0.1 back into develop"
git branch --delete hotfix/1.0.1
```

---

## 2. Commit message convention

Every commit follows **Conventional Commits**.

```
<type>(<scope>): <summary>

<body: what changed and, more importantly, why>

<trailers>
```

### Types

| Type | Use for | Appears in the changelog |
| --- | --- | --- |
| `feat` | A new user-visible capability | yes, under *Added* |
| `fix` | A defect fix | yes, under *Fixed* |
| `perf` | A change made only to improve performance | yes |
| `refactor` | Restructuring with no behaviour change | yes, under *Changed* |
| `test` | Adding or correcting tests | yes |
| `docs` | Documentation only | yes |
| `build` | Build system, dependencies, packaging | yes |
| `ci` | Pipeline configuration | yes |
| `chore` | Routine maintenance with no product effect | hidden |
| `style` | Formatting only | hidden |
| `revert` | Reverting an earlier commit | yes |

### Rules

- Summary is **imperative** ("add", not "added"), lower case, no trailing full
  stop, **72 characters or fewer**.
- The body explains **why**, not what. The diff already says what changed.
- A `feat` or `fix` commit states the user-visible effect in the body.
- Add a `!` after the type or scope for a breaking change, and describe the
  break in the body prefixed `BREAKING CHANGE:`.
- Reference the assessment deliverable the commit serves with a `Refs:` trailer.
- **Every commit must leave the repository working**: `npm test` passes and the
  server starts. No commit is a checkpoint of a half-finished idea.

### Examples from this history

```
feat(config): add layered, validated environment configuration

Externalise configuration from code and resolve it from four ordered
layers so the same build artefact is promotable between environments.
...

Refs: ISYS3001 A2 - configuration management (ULO2)
```

```
test(db,pipeline): cover migrations and request pipeline; fix two defects

Adds twenty-two migration cases and twenty pipeline cases, and fixes the
two defects the pipeline cases exposed.
...
```

---

## 3. Pull request checklist

Even on a single-developer project the checklist is completed before a merge,
because it is the checklist — not the review — that catches the mistakes.

- [ ] The branch is up to date with its target branch (`git rebase` or a merge).
- [ ] `npm test` passes locally with no failures.
- [ ] `npm run smoke` passes against a locally started server.
- [ ] Every commit message follows the convention above.
- [ ] Every new configuration variable is in `DEFAULTS`, in the `.example`
      templates, and in `config/README.md`.
- [ ] Every new secret-valued variable is listed in `REDACTED_KEYS`.
- [ ] A schema change is a **new** migration file; no applied migration is edited.
- [ ] New behaviour has a test; a fixed defect has a test that fails without the fix.
- [ ] `CHANGELOG.md` is regenerated on a `release/*` branch, not on a feature branch.
- [ ] For a `release/*` or `hotfix/*` merge: the merge is also applied to `develop`.

---

## 4. Quality gates run by the pipeline

`.github/workflows/ci.yml` runs these on every push and pull request:

| Job | What it proves |
| --- | --- |
| `verify` | The suite passes, and the coverage thresholds are met |
| `configuration` | Every `.env.<env>.example` profile loads and validates |
| `container` | The image builds and answers `/healthz` and `/readyz` inside the container |
| `changelog` | `CHANGELOG.md` matches what the history would generate |

A red pipeline blocks the merge. The pipeline is the automated form of the
checklist above, and it exists so that the checklist does not depend on the
reviewer remembering it.

---

## 5. Repository hygiene

- `.gitignore` covers dependencies, **all** `.env` variants, SQLite runtime
  files, build and coverage output, logs, and editor noise.
- Only `*.example` environment templates are committed. A real secret in a
  commit is treated as an incident: rotate the secret first, then purge.
- `data/` is never committed. The database is environment state, reproducible
  from migrations.
- `.gitattributes` normalises line endings so a Windows and a Linux checkout
  produce identical diffs.
- `docs/adr/` records *why* a decision was made. A decision that reverses an
  earlier one supersedes it by reference rather than editing it.
