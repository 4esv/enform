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

## Demo seed

DE-4 gives a fresh installation a test organization that can be used end to
end and removed again:

```sh
make seed        # enform seed demo
make seed-clear  # enform seed clear --yes
```

`make seed` creates six demo users in the configured Keycloak realm, the
`registrar-office-<run>` and `chairs-<run>` teams, their grants, a published
`demo-course-overload-<run>` flow and four in-flight instances at the request,
advisor and registrar steps plus one done instance. It prints each demo email,
its generated password and its immutable id once, with the flow URL. enform
stores no password.

The records carry the profile `demo` in the operational `seed_records` table.
`enform seed clear --config <path> --yes` deletes those Keycloak users and the
seeded projection rows, appends one `seed.cleared@1` event and marks the
records cleared. It touches no other record. The append-only log keeps the
events as the audit record, and `enform admin rebuild` re-applies every cleared
record, so a rebuild never resurrects the demo. The flow list, the draft, the
instance read and the inbox exclude a cleared demo; `GET /api/v1/log` and
`/api/v1/state` still show the events.

`enform seed demo --config <path> --json` prints the same credentials as one
JSON object. A second run reports the live profile and changes nothing; after a
clear it starts a new run with fresh ids, emails, team names and flow slug.

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

Add `--smtp-url smtp://mail.example.com:587 --mail-from enform@example.com` to
`enform init` to let the worker send email. Without an SMTP URL the worker
logs the queued side effects once and sends nothing, so an installation
without a mail server still runs; `enform doctor` reports the check as
optional.

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

## Email

The engine records each side effect in the outbox (SE-1, SE-2). The `worker`
claims the due rows, sends them through the SMTP URL and records `queued`,
`sent` or `failed` with the attempt count, the last error and an exponential
backoff. PostgreSQL is the only queue (ADR 0003), so a side effect and its
state change commit together.

Compose runs Mailpit as a real SMTP sink for development and CI. It is not a
fake in the product path: the worker opens an SMTP connection to it exactly as
it opens one to a production server. Open `http://localhost:8025` to read the
messages.

```sh
docker compose -f deploy/compose.yaml up -d --wait postgres keycloak mailpit
enform init ... --smtp-url smtp://127.0.0.1:1025 --mail-from enform@test.local
enform worker --config /etc/enform/enform.toml
```

## Services

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:17` | The store and job queue of ADR 0003. |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | The broker of ADR 0005. |
| `server` | `ENFORM_SERVER_IMAGE` | The engine. It answers under `/api/v1`. |
| `worker` | `ENFORM_WORKER_IMAGE` | Delivers the outbox through SMTP, with retries and backoff. |
| `mailpit` | `axllent/mailpit:v1.27.8` | A real SMTP sink for development and CI. SMTP on 1025, HTTP on 8025. |

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
| `ENFORM_PUBLIC_URL` | `http://localhost:8080` | The public server URL, and the base of the flow/instance link in every email. |
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
| `ENFORM_SMTP_URL` | `smtp://mailpit:1025` in Compose, none otherwise | The SMTP URL the worker sends through. An empty value disables email and leaves the outbox queued. `enform init` writes it when given `--smtp-url`, and `enform doctor` checks it when configured. |
| `ENFORM_MAIL_FROM` | `enform@localhost` | The envelope sender of every enform email. `enform init` writes it when given `--mail-from`. |
| `MAILPIT_SMTP_PORT` | `1025` | The published Mailpit SMTP port. |
| `MAILPIT_HTTP_PORT` | `8025` | The published Mailpit HTTP port. |
| `MAILPIT_MAX_MESSAGES` | `5000` | How many messages Mailpit keeps. |
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
