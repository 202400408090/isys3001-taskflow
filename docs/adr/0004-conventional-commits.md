# 0004. Adopt Conventional Commits for the commit history

- Status: Accepted
- Date: 2026-08-24
- Deciders: project developer
- Related: `CONTRIBUTING.md`, `CHANGELOG.md`, `scripts/generate-changelog.js`

## Context

A commit message is the only artefact that explains *why* a change was made. The
diff already shows *what* changed, but a diff cannot express intent, and it
cannot distinguish a bug fix from a feature from a formatting change.

Two problems followed from unstructured messages:

1. **The history was unsearchable.** A reviewer asked "when did write
   authentication appear?" could not answer it with `git log` alone.
2. **The changelog was written by hand at release time**, from memory. It was
   therefore incomplete, and it duplicated information the history already held.

## Decision

Every commit subject follows the Conventional Commits form:

```
<type>(<scope>): <summary in the imperative mood, max 72 characters>

<body: what changed and, more importantly, why>

<trailers: Refs:, Fixes:, Co-authored-by:>
```

Permitted types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`.

Rules that are enforced by review rather than by a hook, because the project has
a single contributor and no shared hook installation step:

- The summary is imperative and does not end with a full stop.
- A `feat` or `fix` commit states the user-visible effect in the body.
- A commit either compiles and passes tests on its own, or is explicitly marked
  as work in progress — the repository contains no such markers, so every commit
  is green.
- Every commit references the assessment deliverable it serves via a `Refs:`
  trailer.

## Consequences

**Easier**

- The history is queryable: `git log --oneline --grep="^feat"` lists every
  feature, `git log --grep="Fixes:"` lists every defect fix.
- `CHANGELOG.md` can be generated from the history and the tags rather than
  written from memory, which removes a whole class of release-time errors.
- A reviewer can triage a pull request from the subject lines alone.

**Harder / must be maintained**

- Correct labelling requires a judgement call, and `refactor` versus `perf`
  versus `chore` is genuinely ambiguous in some commits. The type is chosen by
  *intent*, not by the shape of the diff.
- Types are convention, not enforcement. Without a commit-msg hook the rule can
  be broken silently. Adding a hook was judged out of scope for a single
  contributor, and the `make log` target exists so the history is inspected
  regularly enough that a malformed message is noticed.
