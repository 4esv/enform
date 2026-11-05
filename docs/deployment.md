# Deployment

<!-- description: Deploy enform with Docker Compose or on bare metal with systemd: the one container image, the configuration file with environment overrides, the ENFORM_* variables, PostgreSQL, Keycloak and SMTP, health endpoints and the first administrator. -->

enform ships one executable in one container image, a Compose file and two systemd units. It needs PostgreSQL for the store and the job queue, Keycloak for sign-in, and an SMTP server for email. Nothing else.

## The pieces

| Service | Role |
|---|---|
| `enform serve` | The engine and the interface on one port. The interface at the root, the API under `/api/v1`, `/healthz` for liveness and `/readyz` for readiness. |
| `enform worker` | Delivers the outbox through SMTP with retries and backoff, fires the due timers, and runs the scheduled directory sync. Reads the same store as the server and decides nothing on its own. |
| PostgreSQL 16 or 17 | The one store: the append-only log, the projections, the outbox, the timers, the sessions. |
| Keycloak 26 | The identity broker. The built-in user store is the default; federation with Active Directory or Entra ID is configured in Keycloak per installation. |
| SMTP | Any server. Without one the worker logs each queued side effect once and sends nothing. |

The service runs as an unprivileged user, logs to stderr, drains on SIGTERM and refuses to start on an invalid configuration.

## Docker Compose

`deploy/compose.yaml` runs the stack: `postgres`, `keycloak`, `mailpit` (a real SMTP sink for development), `server` and `worker`. The service names and the variables below are a public surface and do not change without a changelog entry.

```sh
docker build -f deploy/Dockerfile -t enform:local .
ENFORM_SERVER_IMAGE=enform:local ENFORM_WORKER_IMAGE=enform:local \
  docker compose -f deploy/compose.yaml up -d --wait
docker compose -f deploy/compose.yaml exec server \
  node dist/cli/main.js admin create --admin-email admin@example.com --admin-password 'a long password'
```

`make stack` starts the stack for development. The release images are `ghcr.io/enform/enform-server` and `ghcr.io/enform/enform-worker`; until a release is published, point the two image variables at an image built from `deploy/Dockerfile`.

| Variable | Default | Purpose |
|---|---|---|
| `ENFORM_PUBLIC_URL` | `http://localhost:8080` | The URL people open. Sign-in returns to it. |
| `ENFORM_HTTP_PORT` | `8080` | The published port of the server. |
| `ENFORM_DATABASE_URL` | `postgres://enform:enform@postgres:5432/enform` | The store. |
| `ENFORM_KEYCLOAK_URL`, `ENFORM_KEYCLOAK_REALM` | `http://localhost:8081`, `enform-local` | The identity provider. |
| `ENFORM_KEYCLOAK_CLIENT_ID`, `ENFORM_KEYCLOAK_CLIENT_SECRET` | `enform`, `enform-dev-secret` | The confidential client of the server. |
| `ENFORM_KEYCLOAK_ADMIN_USER`, `ENFORM_KEYCLOAK_ADMIN_PASSWORD` | `admin`, `admin` | The Keycloak administrator the directory pages use. |
| `ENFORM_SMTP_URL`, `ENFORM_MAIL_FROM` | `smtp://mailpit:1025`, `enform@localhost` | The mail transport and sender. |
| `ENFORM_SESSION_IDLE_MINUTES`, `ENFORM_SESSION_ABSOLUTE_HOURS` | `30`, `12` | The browser session limits. |
| `ENFORM_SESSION_ENCRYPTION_KEY` | written by `enform init` | A 32-byte key in base64 that seals stored refresh tokens. |
| `ENFORM_DIRECTORY_SYNC_SECONDS` | `300` | How often the worker synchronizes the accounts with the directory; `0` disables the schedule. |
| `ENFORM_LOG_LEVEL` | `info` | The log level. |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | `enform`, `enform`, `enform`, `5432` | The PostgreSQL service. |
| `KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, `KEYCLOAK_DB` | `admin`, `admin`, `keycloak` | The Keycloak service. |

Change every default password before the stack faces a network. [`deploy/README.md`](../deploy/README.md) lists the realm files Keycloak imports and the full variable table.

## Bare metal

Install Node 26, PostgreSQL and Keycloak, then:

```sh
install -d -m 0750 /etc/enform
enform init --config /etc/enform/enform.toml \
  --database-url postgres://enform:…@db.example.com:5432/enform \
  --public-url https://forms.example.com \
  --keycloak-url https://sso.example.com --keycloak-realm enform \
  --keycloak-client-secret '…' \
  --smtp-url smtp://mail.example.com:587 --mail-from enform@example.com \
  --admin-email admin@example.com --admin-password 'a long password' \
  --no-serve
systemctl enable --now enform.service enform-worker.service
```

`enform init` writes the configuration file with mode `0600`. The units in `deploy/systemd/` run the same binary as the `enform` user and read secrets from `/etc/enform/enform.env` as `ENFORM_*` variables.

## Configuration precedence

A command-line flag wins over the environment, which wins over the configuration file, which wins over the default. Secrets are never in the repository: `enform init` writes them to the file or you pass them through the environment.

## Behind a reverse proxy

Terminate TLS at the proxy and set `ENFORM_PUBLIC_URL` to the public HTTPS URL; sign-in redirects use it. Forward WebSocket upgrades to `/api/v1/realtime` and do not buffer `/api/v1/realtime/events`, or the interface falls back to polling.

## Identity

Sign-in is OIDC through Keycloak. The realm files in `deploy/keycloak/realms/` set up the `enform` confidential client for the server and the `enform-cli` public client with the device grant for the CLI. To federate with Active Directory or Entra ID, configure user federation or an identity provider in that realm; enform sees only immutable subject IDs and group names, and synchronizes group membership at sign-in and on the worker's schedule.

## Health and readiness

`GET /healthz` answers as soon as the process serves. `GET /readyz` answers once the database is reachable and migrated, and is the probe Compose and the units use. `enform doctor` is the deeper check for an operator; see [Operations](operations.md).
