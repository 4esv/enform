# The five commands of enform. CONTRIBUTING.md describes them.
.PHONY: setup check lint typecheck test rules invariants stories stack

setup:
	pnpm install --frozen-lockfile

check: lint typecheck test

lint:
	pnpm exec biome check .

typecheck:
	pnpm exec tsc --noEmit

test:
	pnpm exec vitest run

# The document rule of STORIES.md Coverage (the matrix of story, operator
# and mode). CI runs it after `make check`, like the invariant and changelog
# rules, so that `make check` stays green on the layout copy without test
# files (#95).
rules:
	node tools/matrix-rule.mjs

invariants:
	pnpm exec vitest run --project invariants

stories:
	pnpm exec vitest run --project stories

stack:
	docker compose -f deploy/compose.yaml up --wait
