# API reference

<!-- description: The enform HTTP API under /api/v1, described by one OpenAPI document: the operation append, the log, flows and drafts, dry runs, instances, timelines, the inbox, the Unroutable queue, teams, the directory, sessions, and the realtime channel. -->

The HTTP API is the one public surface of the engine. The web interface, the CLI and every integration use it, through a client generated from the OpenAPI document `api/openapi.yaml`. The path prefix is `/api/v1`. The interface at the site root and the API are served by the same process.

## Authentication

Browsers sign in through `GET /api/v1/auth/login`, which sends the visitor to the identity provider and back to the same location; the session is a server-side cookie with a CSRF token. Clients and the CLI send a bearer token from the identity provider in the `Authorization` header. `GET /api/v1/session` answers the signed-in principal, and `GET /api/v1/auth/cli` tells a CLI which provider and client to use for its device sign-in.

Every read and every write is authorized in the engine from the caller's grants. A refusal answers `403` with the reason and the scope that would allow it.

## Writes

Every change is one operation appended to the log:

```http
POST /api/v1/operations
Content-Type: application/json

{ "operationId": "0b9d…", "type": "task.claim", "at": 1730800000000, "payload": { "instanceId": "…", "expectedVersion": 3 } }
```

The client chooses the operation ID. A retry with the same ID answers the event the server already applied, and the log does not grow. The server resolves the intent through the engine (routing, authorization, validation) and answers the event it appended, or `403` for a refusal, `409` for a stale version, `422` for invalid data.

## Reads

| Path | Answers |
|---|---|
| `GET /api/v1/log?after=&flow=&instance=&limit=` | The events the caller may read, in log order. The cursor `after` serves polling. |
| `GET /api/v1/state` | The state rebuilt from the log, for tools. |
| `GET /api/v1/flows` | The flows the caller may see. |
| `POST /api/v1/flows` | Creates a flow with a draft. |
| `GET /api/v1/flows/{slug}` | The published flow; `?version=n` for one version. |
| `GET /api/v1/flows/{slug}/draft` | The draft definition and its version. |
| `PUT /api/v1/flows/{slug}/draft` | Writes the draft; needs the current version. Edits to different parts merge; a change to the same path answers `409` with the conflicting paths. |
| `POST /api/v1/flows/{slug}/publish` | Publishes the draft as the next version. |
| `POST /api/v1/flows/{slug}/dry-run` | Runs a version or the draft against data: the route, the assignees, the preview inbox, the timers. `as` needs `org.impersonate`. |
| `GET /api/v1/flows/{slug}/grants` | The grants of the flow, as scopes. |
| `GET /api/v1/instances/{id}` | The instance as the current step sees it: values, status line, tracker, outcomes. |
| `GET /api/v1/instances/{id}/timeline?includeChanges=1` | The timeline, with the configuration changes when asked. |
| `GET /api/v1/instances/{id}/pdf` | The instance as a PDF for the current step. |
| `GET /api/v1/inbox?tab=` | My tasks, Available, Started by me. |
| `GET /api/v1/unroutable` | The Unroutable queue. |
| `GET /api/v1/timeline?flow=&type=` | The global change feed. |
| `GET /api/v1/teams` | The teams and their members. |
| `GET`, `POST /api/v1/admin/users`, `GET /api/v1/admin/groups` | The built-in directory. |

## Realtime

| Path | Answers |
|---|---|
| `GET /api/v1/realtime` (WebSocket) | The channel: a handshake that agrees the protocol version, subscriptions to an instance or a flow, change and presence messages, and a reload request when the interface is outdated. |
| `GET /api/v1/realtime/events?instance=&flow=` (Server-Sent Events) | The same changes as a stream, for a client that cannot open a WebSocket. |

The message schema is `schemas/realtime/v1.json`. The fallback order a client follows is in [Realtime and offline](realtime-offline.md).

## Event types

Every event type carries a version suffix (`task.claimed@1`) and has a schema under `schemas/events/`. The engine never rewrites an event; a changed shape gets a new type version, and an upcaster converts old events when the engine reads them.

## Versioning

The API is versioned by its path prefix and the OpenAPI document. A breaking change to it increments the minor version before 1.0.0 and the major version after, and the changelog lists it under Breaking with migration steps. The generated client in the interface is regenerated from the document in the same change (`make client`), so the interface cannot drift from the contract.

## The document

The full OpenAPI document is in the repository: [`api/openapi.yaml`](https://github.com/4esv/enform/blob/main/api/openapi.yaml). It is the source of the generated client, and every operation above is described there with its parameters, bodies and answers.
