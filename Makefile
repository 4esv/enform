# The five commands of enform. CONTRIBUTING.md describes them.
.PHONY: setup check lint typecheck test invariants stories stack

setup:
	pnpm install --frozen-lockfile

check: lint typecheck test

lint:
	pnpm exec biome check .

typecheck:
	pnpm exec tsc --noEmit

test:
	pnpm exec vitest run

invariants:
	pnpm exec vitest run --project invariants

stories:
	pnpm exec vitest run --project stories

stack:
	docker compose -f deploy/compose.yaml up --wait
