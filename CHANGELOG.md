# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This file is **generated from the Git history** by `scripts/generate-changelog.js`.
> Edit the history, not this file: run `make changelog` to regenerate it.

## [Unreleased]

No release tag exists yet. Commit history so far:

### Added

- **client:** add the single-page task client (`1df4ff4`)
- **tasks:** add task model with filtering and optimistic locking (`d098aab`)
- **db:** add versioned, forward-only schema migrations (`a3d35e2`)
- **db:** add SQLite connection management (`f2ce01b`)
- **api:** add task and health endpoints (`b10619b`)
- **http:** add request pipeline, router and error handling (`ab23e0d`)
- **api:** add domain errors and input validation (`8c6bd0c`)
- **config:** add layered, validated environment configuration (`76b10e3`)

### Fixed

- **release:** allow a stopped release sequence to be resumed (`573abc8`)
- **release:** run the test suite without depending on npm on the PATH (`f8bddbc`)
- **release:** allow the first release to reuse the declared version (`5ee8c24`)

### Build

- **scripts:** add the migration, seed and smoke-test commands (`d189b32`)
- add the operations scripts and the one-command workflows (`7523ae6`)
- add the container image and Compose deployment configuration (`930d35f`)

### Continuous integration

- add the pipeline and derived changelog generation (`961cc39`)

### Tests

- **db,pipeline:** cover migrations and request pipeline; fix two defects (`7c25b57`)
- **tasks:** add an API contract suite driving the real HTTP surface (`4e3f2ef`)

### Documentation

- **changelog:** regenerate for 1.0.0 (`cd43fa4`)
- record the version control strategy with the branch evidence (`cfb9645`)
- **changelog:** add the initial generated changelog (`9862b94`)
- document the deployment configuration and the rollback procedure (`4da5149`)
- **config:** add the environment profiles and the decision records (`797a2f9`)
- document the version control conventions (`f71c00b`)
