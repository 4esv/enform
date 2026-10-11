# The five commands of enform. CONTRIBUTING.md describes them.
.PHONY: setup browsers check lint typecheck test rules client invariants stories stack

setup:
	pnpm install --frozen-lockfile
	pnpm exec playwright install chromium

# The Chromium build that `gui` mode uses (ADR 0009, STORIES.md Test method). It
# downloads once, into the shared Playwright cache. The browser OS libraries are
# system packages, which `playwright install-deps` installs on Linux only, so CI
# does that in a step of its own.
browsers:
	pnpm exec playwright install chromium

check: lint typecheck test

lint:
	pnpm exec biome check .

typecheck:
	pnpm exec tsc --noEmit

test:
	pnpm exec vitest run

# The rules that CI runs next to `make check`: the document rule of STORIES.md
# Coverage (the matrix of story, operator and mode) and the public API rule of
# I12 (the interface uses only the public API). CI runs them after `make check`,
# like the invariant and changelog rules, so that `make check` stays green on
# the layout copy without test files (#95).
rules:
	node tools/matrix-rule.mjs
	node tools/public-api-rule.mjs

# Regenerate the interface API client from api/openapi.yaml (DX-4, I12). The
# generated client is checked in, and tools/client.test.ts fails when it drifts
# from the generator output.
client:
	node tools/generate-client.mjs

invariants:
	pnpm exec vitest run --project invariants

stories:
	pnpm exec vitest run --project stories

stack:
	docker compose -f deploy/compose.yaml up --wait
