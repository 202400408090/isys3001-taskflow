# 0003. Adopt Git Flow as the branching strategy

- Status: Accepted
- Date: 2026-08-24
- Deciders: project developer
- Related: `CONTRIBUTING.md`, `docs/version-control-strategy.md`

## Context

The application needs a branching model that does four things:

1. Keeps `main` in a state that is always deployable, because `main` is the
   branch the release pipeline builds from.
2. Allows a feature to be developed over several commits without destabilising
   the integration line.
3. Provides a place to stabilise a release — version bumps, changelog, final
   defect fixes — without holding back work on the next feature.
4. Provides a disciplined route for an urgent production fix that must not drag
   half-finished features into production with it.

The realistic candidates were **GitHub Flow** (a single long-lived `main` plus
short-lived topic branches, deployed on merge) and **Git Flow** (the two
long-lived branches `main` and `develop`, with `feature/*`, `release/*` and
`hotfix/*` supporting branches).

## Decision

Adopt **Git Flow**.

- `main` holds released code only. Every commit on `main` is a released version
  and carries an annotated tag. The release pipeline builds from `main` alone.
- `develop` is the integration branch and the default target for feature merges.
- `feature/*` branches from `develop`, merges back to `develop` with `--no-ff`
  so the feature remains a visible unit in the history.
- `release/*` branches from `develop` for version bump, changelog and final
  fixes, then merges to `main` (tagged) **and** back to `develop`.
- `hotfix/*` branches from `main`, merges to `main` (tagged) and back to
  `develop`, so the fix is never lost by the next release.

## Consequences

**Easier**

- `main` is always releasable, which makes the "build from main only" pipeline
  rule safe to enforce.
- `release/*` gives a concrete freeze point: the changelog and version bump are
  ordinary commits on a branch that can be reviewed before the tag is cut.
- `hotfix/*` from `main` means an emergency fix ships without waiting for the
  next release train and without carrying unrelated work.
- `--no-ff` feature merges leave an explicit record of feature boundaries, which
  makes `git log --graph` legible as evidence of process.

**Harder / must be maintained**

- Two long-lived branches must be kept in step: every `release/*` and `hotfix/*`
  merge to `main` must also be merged back to `develop`, or the next release
  silently reverts the fix. The pull-request checklist in `CONTRIBUTING.md`
  exists to catch this.
- The model is heavier than GitHub Flow. On a single-developer project the
  ceremony of a `release/*` branch is not always repaid, and the honest
  justification here is partly that the unit assesses branching strategy, so the
  process must be demonstrable.
- Merge commits make the history non-linear, so `git log --oneline` alone does
  not tell the story. This is why `docs/version-control-strategy.md` records the
  branch point and merge commit for every branch in the form of a table.
