# Architecture Decision Records

An **Architecture Decision Record** (ADR) captures one significant technical
decision together with the context that produced it and the consequences that
follow from it. ADRs are version controlled next to the code they describe, so
that the *reasoning* behind a design survives alongside the design itself.

Keeping decisions in the repository is a configuration management practice: it
makes the change history of the design as auditable as the change history of
the source code, and it stops the same debate from being re-opened and
re-litigated six weeks later.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-decisions-in-the-repository.md) | Record architectural decisions in the repository | Accepted |
| [0002](0002-layered-environment-configuration.md) | Layer configuration by environment | Accepted |
| [0003](0003-git-flow-branching-strategy.md) | Adopt Git Flow as the branching strategy | Accepted |
| [0004](0004-conventional-commits.md) | Adopt Conventional Commits for the commit history | Accepted |
| [0005](0005-sqlite-via-node-builtin.md) | Reach the database through `node:sqlite` | Accepted |

## Template

```markdown
# NNNN. Short title of the decision

- Status: Proposed | Accepted | Superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Deciders: names or roles

## Context
What forces are at play? What problem needs a decision?

## Decision
What was decided, stated in one or two sentences.

## Consequences
What becomes easier, what becomes harder, and what must now be maintained.
```
