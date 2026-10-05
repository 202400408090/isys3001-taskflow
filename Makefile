# ===========================================================================
# TaskFlow - developer and operations entry points
#
# WHY A MAKEFILE
#
# The instructions a developer must follow are the project's most-used interface,
# and an interface that lives only in a README is an interface that drifts from
# the code. Declaring each operation once, here, means the README can tell a
# reader to run `make setup` and be certain about what happens.
#
# Every target is also runnable directly. The Makefile adds discoverability and
# argument defaults, not hidden behaviour: run `make help` for the list.
#
# On Windows, run these from Git Bash, from WSL, or use the npm script that each
# target wraps. `make help` is the fastest way to find the equivalent.
# ===========================================================================

SHELL := /bin/sh
.DEFAULT_GOAL := help

# --- Version and build metadata --------------------------------------------
VERSION       ?= $(shell cat VERSION 2>/dev/null || echo 0.0.0)
GIT_COMMIT    ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_BRANCH    ?= $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
BUILD_TIME    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
IMAGE         ?= isys3001/taskflow:$(VERSION)
APP_PORT      ?= 3000
SMOKE_BASE_URL ?= http://127.0.0.1:$(APP_PORT)

# Colours are emitted only when writing to a terminal, so a CI log stays clean.
ifneq (,$(findstring xterm,$(TERM)))
  C_OK   := \033[32m
  C_WARN := \033[33m
  C_ERR  := \033[31m
  C_DIM  := \033[2m
  C_OFF  := \033[0m
else
  C_OK :=
  C_WARN :=
  C_ERR :=
  C_DIM :=
  C_OFF :=
endif

.PHONY: help setup install env test test-coverage migrate migrate-status seed \
        run dev smoke lint changelog changelog-check release bump tag \
        verify env-check docker-build docker-up docker-down docker-logs \
        docker-shell docker-clean ci clean prune

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

help: ## Show every available target
	@printf '\n'
	@printf '  TaskFlow %s  %s(%s) on %s%s\n' "$(VERSION)" "$(C_DIM)" "$(GIT_COMMIT)" "$(GIT_BRANCH)" "$(C_OFF)"
	@printf '  %s\n' "----------------------------------------------------------------------------"
	@printf '\n  Development\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; $$1 ~ /^(setup|install|env|run|dev|test|test-coverage|lint|clean|prune)$$/ {printf "    %-18s %s\n", $$1, $$2}'
	@printf '\n  Database\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; $$1 ~ /^(migrate|migrate-status|seed)$$/ {printf "    %-18s %s\n", $$1, $$2}'
	@printf '\n  Release process\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; $$1 ~ /^(changelog|changelog-check|release|bump|tag|verify|env-check)$$/ {printf "    %-18s %s\n", $$1, $$2}'
	@printf '\n  Containers\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; $$1 ~ /^docker-/ {printf "    %-18s %s\n", $$1, $$2}'
	@printf '\n  Verification\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; $$1 ~ /^(smoke|ci)$$/ {printf "    %-18s %s\n", $$1, $$2}'
	@printf '\n  %sEvery target is also an npm script; `make help` lists the pair.%s\n\n' "$(C_DIM)" "$(C_OFF)"

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------

setup: env install ## Prepare a fresh clone to run
	@printf '  %sReady.%s Next: make migrate && make seed && make dev\n\n' "$(C_OK)" "$(C_OFF)"

install: ## Install dependencies (none are required at runtime)
	@printf '  %sThe project has no runtime dependencies; nothing to install.%s\n' "$(C_DIM)" "$(C_OFF)"
	@node -e "const p=require('./package.json');const n=Object.keys(p.dependencies||{}).length;if(n>0){console.error('  Runtime dependencies exist: run npm install');process.exit(1)}"
	@node --version | awk '{printf "  Node.js %s\n", $$1}'

env: ## Create .env from the template if it does not exist
	@if [ -f .env ]; then \
		printf '  %s.env already exists; left unchanged.%s\n' "$(C_DIM)" "$(C_OFF)"; \
	else \
		cp .env.example .env; \
		printf '  %sCreated .env from .env.example. Review it before running in a shared environment.%s\n' "$(C_OK)" "$(C_OFF)"; \
	fi

run: ## Start the server in the foreground
	@npm start

dev: ## Start the server with automatic restart on change
	@npm run dev

test: ## Run the automated test suite
	@npm test

test-coverage: ## Run the suite and report line and branch coverage
	@npm run test:coverage

lint: verify ## Run the repository readiness checks

clean: ## Remove generated output and caches (keeps .env and data/)
	@rm -rf coverage .nyc_output dist build .cache .tmp
	@printf '  %sRemoved build output and caches.%s\n' "$(C_OK)" "$(C_OFF)"

prune: clean ## Also delete the local development database
	@rm -rf data
	@printf '  %sRemoved build output, caches and the local database.%s\n' "$(C_WARN)" "$(C_OFF)"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

migrate: ## Apply pending database migrations
	@npm run --silent migrate

migrate-status: ## Report the state of every migration
	@npm run --silent migrate:status

seed: ## Insert the sample task set
	@npm run --silent seed

# ---------------------------------------------------------------------------
# Release process
# ---------------------------------------------------------------------------

changelog: ## Regenerate CHANGELOG.md from the Git history
	@node scripts/generate-changelog.js

changelog-check: ## Fail if CHANGELOG.md is out of date with the history
	@node scripts/generate-changelog.js --check

release: ## Cut a release: make release VERSION=1.1.0
	@if [ -z "$(VERSION_OVERRIDE)" ] && [ "$(VERSION)" = "$$(cat VERSION)" ]; then \
		printf '  %sSpecify the new version: make release VERSION=1.1.0%s\n' "$(C_ERR)" "$(C_OFF)"; exit 1; \
	fi
	@node scripts/release.js release $(VERSION)

bump: ## Write a new version: make bump VERSION=1.1.0
	@node scripts/release.js bump $(VERSION)

tag: ## Annotated-tag the current main commit: make tag VERSION=1.1.0
	@node scripts/release.js tag $(VERSION)

verify: ## Check the repository is ready to release
	@node scripts/release.js verify

env-check: ## Validate every committed environment profile
	@node scripts/validate-env.js

# ---------------------------------------------------------------------------
# Containers
#
# The build metadata is passed as build arguments rather than read from the
# build context, so the resulting image can report the exact commit it was built
# from and two builds of the same source are distinguishable.
# ---------------------------------------------------------------------------

docker-build: ## Build the container image with build metadata applied
	@printf '  Building %s\n' "$(IMAGE)"
	@docker build \
		--tag $(IMAGE) \
		--tag isys3001/taskflow:latest \
		--build-arg APP_VERSION=$(VERSION) \
		--build-arg GIT_COMMIT=$(GIT_COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		--file Dockerfile .
	@printf '  %sBuilt %s%s\n' "$(C_OK)" "$(IMAGE)" "$(C_OFF)"
	@docker image inspect $(IMAGE) --format '  size {{.Size}} bytes  created {{.Created}}'

docker-up: ## Start the stack in the background
	@APP_VERSION=$(VERSION) GIT_COMMIT=$(GIT_COMMIT) BUILD_TIME=$(BUILD_TIME) APP_PORT=$(APP_PORT) \
		docker compose up --build --detach
	@printf '\n  Waiting for readiness on port %s' "$(APP_PORT)"
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		if curl --silent --fail $(SMOKE_BASE_URL)/readyz >/dev/null 2>&1; then \
			printf '\n  %sReady: %s%s\n\n' "$(C_OK)" "$(SMOKE_BASE_URL)" "$(C_OFF)"; exit 0; \
		fi; \
		printf '.'; sleep 2; \
	done; \
	printf '\n  %sNot ready after 30s. Inspect with: make docker-logs%s\n\n' "$(C_ERR)" "$(C_OFF)"; \
	docker compose logs --tail 40 app; exit 1

docker-down: ## Stop the stack, keeping the database volume
	@docker compose down
	@printf '  %sStopped. The database volume was kept.%s\n' "$(C_OK)" "$(C_OFF)"

docker-clean: ## Stop the stack and delete the database volume
	@docker compose down --volumes --remove-orphans
	@printf '  %sStopped and the database volume was deleted.%s\n' "$(C_WARN)" "$(C_OFF)"

docker-logs: ## Follow the application logs
	@docker compose logs --follow app

docker-shell: ## Open a shell inside a throwaway container
	@docker run --rm --interactive --tty \
		--entrypoint /bin/sh \
		--env NODE_ENV=development \
		--env DATABASE_PATH=/tmp/taskflow.sqlite \
		$(IMAGE)

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

smoke: ## Run the post-deployment smoke test against SMOKE_BASE_URL
	@SMOKE_BASE_URL=$(SMOKE_BASE_URL) node scripts/smoke-test.js

ci: install env-check test changelog-check ## Reproduce the pipeline locally
	@printf '\n  %sLocal pipeline complete.%s Run `make docker-build` to check the image.\n\n' "$(C_OK)" "$(C_OFF)"
