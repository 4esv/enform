# Deployment configuration

`compose.yaml`, its environment variables and its service names are a public
surface (MVP.md 9.1). `make stack` runs
`docker compose -f deploy/compose.yaml up --wait`. Issue #97 adds the stack.

## Services

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:17` | The store and job queue of ADR 0003. |
| `keycloak` | `quay.io/keycloak/keycloak:26.0` | The broker of ADR 0005. |
| `server` | `ENFORM_SERVER_IMAGE` | The engine. It answers under `/api/v1`. |
| `worker` | `ENFORM_WORKER_IMAGE` | Runs side effects from the outbox. |

The server and the worker do not exist in 0.1.0. Their images are the release
images that the build pipeline publishes. Until then, override
`ENFORM_SERVER_IMAGE` and `ENFORM_WORKER_IMAGE`.

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
| `ENFORM_OIDC_ISSUER_URL` | `http://keycloak:8080/realms/enform-ad` | The realm issuer. |
| `ENFORM_OIDC_CLIENT_ID` | `enform` | The OIDC client id. |
| `ENFORM_OIDC_CLIENT_SECRET` | `enform-dev-secret` | The OIDC client secret. |
| `ENFORM_SERVER_URL` | `http://server:8080` | The server URL the worker uses. |
| `ENFORM_LOG_LEVEL` | `info` | The log level. |

## Keycloak realms

`keycloak/realms/` holds two test realms. Keycloak imports them at start.

- `ad-realm.json` federates an on-premises Active Directory over LDAP and
  uses `objectGUID` as the immutable identifier (ID-1, ID-4).
- `entra-realm.json` brokers Microsoft Entra ID over OIDC and maps the `oid`
  claim to `entra_object_id` (ID-1, ID-4).

Both realms define the `enform` OIDC client. The values in the realm files
are local test values. A real deployment replaces them.
