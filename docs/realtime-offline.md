# Realtime and offline

<!-- description: What the enform interface does on a good, a bad and no connection: the WebSocket, Server-Sent Events, polling and offline modes, presence, local-first drafts sealed on the device, the offline submit queue and idempotent retries. -->

No work is lost, also on a bad network. The interface keeps working when the connection degrades and says what it is doing in the header.

## Connection modes

The interface follows the instance or the flow it shows over a realtime channel, and falls back in this order:

| Mode | Transport | What you see |
|---|---|---|
| Live | WebSocket at `/api/v1/realtime` | Changes made elsewhere appear at once. Presence shows who else is here. |
| Degraded | Server-Sent Events at `/api/v1/realtime/events` | Changes still arrive; presence may lag. |
| Polling | `GET /api/v1/log?after=<seq>` | Changes arrive within seconds. |
| Offline | None | The page shows the last state it saw, marked as such, and keeps your edits on the device. |

The header always shows the mode. A change made elsewhere is applied once no control of the page has the focus, so typing is never clobbered, and the page announces it when you are in the middle of an edit.

The realtime protocol has a published schema and a version the client and the server agree on in the handshake. When the server tells a client to reload, the page loads the newer interface.

## Presence

On an instance and in the builder, the header shows who else is looking and, in the builder, at which field. Presence rides on the same channel and needs nothing to be configured.

## Local-first drafts

Every edit to a request form is saved on the device before it is sent. Each field shows "Saved on this device" until the server acknowledged it and "Synced" after. The device copy is sealed with a session key (AES-256-GCM through the browser's Web Crypto), kept in the browser's IndexedDB, and destroyed when you sign out or after thirty idle minutes, together with the key.

A refresh shows the device's copy at once: a service worker keeps the application shell and the reads a page needs, so the page opens without a connection and restores the draft from the sealed copy.

## Offline submit

A submit made offline waits in a queue with the label "Will submit when you are back online" and follows when the connection returns. The queue sends each operation with the ID the client chose, so a retry after a timeout or a lost answer appends nothing the second time: the server answers the event it already applied.

## What happens when

| Situation | Behaviour |
|---|---|
| The connection drops while typing | Edits keep saving on the device. The header says Offline. |
| The page is refreshed while offline | The shell and the draft come from the device. |
| The connection returns | The queue flushes in order. Fields turn to Synced. The page re-reads the server's state. |
| The form's definition changed while a draft was open | The draft moves to the new version, keeps each value that fits, highlights a new required field, and shows a value that no longer fits without deleting it. |
| The same operation is sent twice | The second send is answered with the first result. The log does not grow. |

## For developers

The transport lives in the interface's `realtime` module and the local store in its `local` module; both are thin over the generated API client. The server's channel and stream are documented in the [API reference](api.md), and the message schema is `schemas/realtime/v1.json`.
