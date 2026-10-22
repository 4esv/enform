# Deployment configuration

`compose.yaml`, its environment variables and its service names are a public
surface (MVP.md 9.1). `make stack` runs
`docker compose -f deploy/compose.yaml up --wait`. Issue #97 adds the stack.

## Quick start

`make init` is the documented one-command bootstrap of DE-1. It starts the
Compose `postgres` and `keycloak` services when they are not reachable, then
runs `enform init`, which writes the configuration, creates the database, runs
the migrations, creates the first administrator and serves the configured
public URL. It reads `.env` and the `ENFORM_*` variables of the environment.

| Variable | Default in `make init` |
|---|---|
| `ENFORM_CONFIG` | `$XDG_CONFIG_HOME/enform/enform.toml` (or `$HOME/.config/enform/enform.toml`) |
| `ENFORM_DATABASE_URL` | `postgres://enform:enform@127.0.0.1:5432/enform` |
| `ENFORM_PUBLIC_URL` | `http://localhost:8080` |
| `ENFORM_KEYCLOAK_URL` | `http://localhost:8081` |
| `ENFORM_KEYCLOAK_REALM` | `enform-local` |
| `ENFORM_KEYCLOAK_ADMIN_USER` | `admin` |
| `ENFORM_KEYCLOAK_ADMIN_PASSWORD` | `admin` |
| `ENFORM_ADMIN_EMAIL` | `admin@example.com` |
| `ENFORM_ADMIN_PASSWORD` | `admin-dev-password` |

## Bare metal

The `enform.service` and `enform-worker.service` units in `systemd/` run the
same binary as the unprivileged `enform` user. An installation writes the
configuration before it starts the units:

```sh
install -d -m 0750 /etc/enform
enform init --config /etc/enform/enform.toml \
  --admin-email admin@example.com --admin-password 'a long password' \
  --no-serve
systemctl enable --now enform.service enform-worker.service
```

`enform init` writes the file with mode `0600`. Secrets may also come from
`/etc/enform/enform.env`, which the units read as `ENFORM_*` variables; a
command-line flag wins over the environment, which wins over the file, which
wins over the default (ADR 0011).

## Container

`deploy/Dockerfile` is a multi-stage Node 26 build. It runs `pnpm build`, copies
`dist/`, `schemas/`, `server/migrations/` and `interface/`, and runs as the
unprivileged `enform` user. The server serves the interface at the site root and
the API under `/api/v1`, so one container answers both:

```sh
docker build -f deploy/Dockerfile -t enform:local .
docker run --rm -p 8080:8080 enform:local version
```

The image entry point is `node dist/cli/main.js`, so the same image runs
`serve`, `worker`, `migrate` and `admin`.

## Services

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:17` | The store and job queue of ADR 0003. |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | The broker of ADR 0005. |
| `server` | `ENFORM_SERVER_IMAGE` | The engine. It answers under `/api/v1`. |
| `worker` | `ENFORM_WORKER_IMAGE` | Runs side effects from the outbox. |

The server and the worker images are the release images that the build
pipeline publishes. Until then, override `ENFORM_SERVER_IMAGE` and
`ENFORM_WORKER_IMAGE` with an image built from `deploy/Dockerfile`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `POSTGRES_USER` | `enform` | The PostgreSQL role. |
| `POSTGRES_PASSWORD` | `enform` | The PostgreSQL password. |
| `POSTGRES_DB` | `enform` | The enform database. |
| `POSTGRES_PORT` | `5432` | The published PostgreSQL port. |
| `KEYCLOAK_DB` | `keycloak` | The Keycloak database. |
| `KEYCLOAK_ADMIN` | `admin` | The Keycloak bootstrap admin. |
| `KEYCLOAK_ADMIN_PASSWORD` | `admin` | The admin password. |
| `KEYCLOAK_PORT` | `8081` | The published Keycloak port. |
| `ENFORM_SERVER_IMAGE` | `ghcr.io/enform/enform-server:0.1.0` | The engine image. |
| `ENFORM_WORKER_IMAGE` | `ghcr.io/enform/enform-worker:0.1.0` | The worker image. |
| `ENFORM_HTTP_ADDR` | `0.0.0.0:8080` | The server listen address. |
| `ENFORM_HTTP_PORT` | `8080` | The published server port. |
| `ENFORM_PUBLIC_URL` | `http://localhost:8080` | The public server URL. |
| `ENFORM_DATABASE_URL` | `postgres://enform:enform@postgres:5432/enform` | The store URL. |
| `ENFORM_OIDC_ISSUER_URL` | `http://keycloak:8080/realms/enform-local` | The realm issuer (legacy name for `ENFORM_KEYCLOAK_URL` and `ENFORM_KEYCLOAK_REALM`). |
| `ENFORM_OIDC_CLIENT_ID` | `enform` | The OIDC client id (legacy name). |
| `ENFORM_OIDC_CLIENT_SECRET` | `enform-dev-secret` | The OIDC client secret (legacy name). |
| `ENFORM_KEYCLOAK_URL` | `http://localhost:8081` | The Keycloak base URL. |
| `ENFORM_KEYCLOAK_REALM` | `enform-local` | The realm that signs users in. |
| `ENFORM_KEYCLOAK_CLIENT_ID` | `enform` | The OIDC client id. |
| `ENFORM_KEYCLOAK_CLIENT_SECRET` | `enform-dev-secret` | The OIDC client secret. |
| `ENFORM_KEYCLOAK_ADMIN_USER` | `admin` | The Keycloak bootstrap admin. |
| `ENFORM_KEYCLOAK_ADMIN_PASSWORD` | `admin` | The Keycloak bootstrap admin password. |
| `ENFORM_SESSION_COOKIE_NAME` | `enform_session` | The server-side session cookie. |
| `ENFORM_SESSION_IDLE_MINUTES` | `30` | The idle timeout of a session. |
| `ENFORM_SESSION_ABSOLUTE_HOURS` | `12` | The absolute lifetime of a session. |
| `ENFORM_SESSION_ENCRYPTION_KEY` | none | The base64 32-byte key that encrypts the refresh token at rest. `enform init` writes one when the configuration has none, and `enform doctor` checks it. |
| `ENFORM_SERVER_URL` | `http://server:8080` | The server URL the worker uses. |
| `ENFORM_LOG_LEVEL` | `info` | The log level. |

## Keycloak realms

`keycloak/realms/` holds three test realms. Keycloak imports them at start.
`enform-local` is the built-in local directory and the default of ID-6; it
needs no federation.

- `local-realm.json` is the built-in directory. It defines the `enform` OIDC
  client with the authorization-code flow and the direct grant.
- `ad-realm.json` federates an on-premises Active Directory over LDAP and
  uses `objectGUID` as the immutable identifier (ID-1, ID-4). It is an
  optional override.
- `entra-realm.json` brokers Microsoft Entra ID over OIDC and maps the `oid`
  claim to `entra_object_id` (ID-1, ID-4). It is an optional override.

All realms define the `enform` OIDC client. The values in the realm files
are local test values. A real deployment replaces them.
