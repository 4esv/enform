# The commands of enform. CONTRIBUTING.md describes them.
.PHONY: setup browsers check lint typecheck test browser rules client invariants stories stack integration init seed seed-clear

setup:
	pnpm install --frozen-lockfile
	pnpm exec playwright install chromium

# The Chromium build that `gui` mode uses (ADR 0009, STORIES.md Test method). It
# downloads once, into the shared Playwright cache. The browser OS libraries are
# system packages, which `playwright install-deps` installs on Linux only, so CI
# does that in a step of its own.
browsers:
	pnpm exec playwright install chromium

check: lint typecheck test browser

lint:
	pnpm exec biome check .

typecheck:
	pnpm exec tsc --noEmit

# The unit, invariant and story suites. The browser suite runs on its own
# (vitest.config.ts), so no test starves while Chromium starts.
test:
	pnpm exec vitest run --project unit --project invariants --project stories

# The browser suite: `gui` mode drives Chromium (#27).
browser:
	pnpm exec vitest run --project browser

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

# The integration suite: the real server against the Compose PostgreSQL and
# Keycloak (DE-1, DE-3, ID-6). It is not part of `make check`, because it needs
# the stack; CI starts the two services first.
integration:
	pnpm exec vitest run --project integration

stack:
	docker compose -f deploy/compose.yaml up --wait

# The documented one-command bootstrap of DE-1. It starts the store and the
# directory when they are not reachable, then `enform init` writes the
# configuration, creates the database, migrates it, creates the first
# administrator and serves. A bare-metal install uses the systemd units and
# `/etc/enform/enform.toml` instead (deploy/README.md).
init:
	docker compose -f deploy/compose.yaml up -d --wait postgres keycloak
	pnpm exec node --experimental-strip-types cli/main.ts init \
		--config "$${ENFORM_CONFIG:-$${XDG_CONFIG_HOME:-$$HOME/.config}/enform/enform.toml}" \
		--database-url "$${ENFORM_DATABASE_URL:-postgres://enform:enform@127.0.0.1:5432/enform}" \
		--public-url "$${ENFORM_PUBLIC_URL:-http://localhost:8080}" \
		--keycloak-url "$${ENFORM_KEYCLOAK_URL:-http://localhost:8081}" \
		--keycloak-realm "$${ENFORM_KEYCLOAK_REALM:-enform-local}" \
		--keycloak-admin-user "$${ENFORM_KEYCLOAK_ADMIN_USER:-admin}" \
		--keycloak-admin-password "$${ENFORM_KEYCLOAK_ADMIN_PASSWORD:-admin}" \
		--admin-email "$${ENFORM_ADMIN_EMAIL:-admin@example.com}" \
		--admin-password "$${ENFORM_ADMIN_PASSWORD:-admin-dev-password}" \
		--no-open

# The demo organization of DE-4: six users, two teams, their grants, a
# published flow and four in-flight instances. The passwords are printed once.
seed:
	pnpm exec node --experimental-strip-types cli/main.ts seed demo \
		--config "$${ENFORM_CONFIG:-$${XDG_CONFIG_HOME:-$$HOME/.config}/enform/enform.toml}"

# Remove only the records that `make seed` marked. The log keeps its events
# (I4), and a rebuild reproduces the cleared state.
seed-clear:
	pnpm exec node --experimental-strip-types cli/main.ts seed clear \
		--config "$${ENFORM_CONFIG:-$${XDG_CONFIG_HOME:-$$HOME/.config}/enform/enform.toml}" \
		--yes
