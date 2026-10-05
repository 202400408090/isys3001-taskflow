# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This file is **generated from the Git history** by `scripts/generate-changelog.js`.
> Edit the history, not this file: run `make changelog` to regenerate it.

## [Unreleased]

No release tag exists yet. Commit history so far:

### Added

- **api:** add task and health endpoints (`b74fb33`)
- **http:** add request pipeline, router and error handling (`7c00c74`)
- **tasks:** add task model with filtering and optimistic locking (`57f0b1a`)
- **db:** add versioned, forward-only schema migrations (`1aee585`)
- **db:** add SQLite connection management (`604d690`)
- **api:** add domain errors and input validation (`9738f63`)
- **config:** add layered, validated environment configuration (`76b10e3`)

### Tests

- **db,pipeline:** cover migrations and request pipeline; fix two defects (`f3cdadb`)
- **tasks:** add an API contract suite driving the real HTTP surface (`8720f51`)
