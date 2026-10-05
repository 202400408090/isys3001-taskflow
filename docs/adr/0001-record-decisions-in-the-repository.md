# 0001. Record architectural decisions in the repository

- Status: Accepted
- Date: 2026-08-24
- Deciders: project developer

## Context

The project makes a series of decisions that are easy to make and expensive to
reconstruct: which branching model to use, how configuration is layered, why the
database is reached through a standard-library module rather than an installed
driver, and how the deployment is structured.

Team knowledge of *why* a decision was taken decays much faster than knowledge of
*what* the code does. Six weeks after a choice is made, a reader can see the
result in the source but not the alternatives that were rejected, and so the same
debate is reopened — usually by someone proposing the option that was already
rejected for a reason nobody recorded.

## Decision

Significant architectural decisions are recorded as numbered Architecture
Decision Records under `docs/adr/`, in the same repository as the code, using the
Context / Decision / Consequences structure. Records are immutable once accepted:
a later decision that reverses one supersedes it by reference rather than editing
it.

## Consequences

**Easier**

- The reasoning behind the design is version controlled and reviewable in the
  same history as the code it describes.
- Change history becomes auditable at the design level, not only the code level.
- Onboarding is faster because the rejected alternatives are stated once.

**Harder / must be maintained**

- Writing a record is deliberate work that must be done at decision time, since
  the value comes from the context being fresh.
- Superseding rather than editing means the directory grows and occasionally
  contains records that no longer reflect the current design. The status field
  and the index table are what keep that navigable.
