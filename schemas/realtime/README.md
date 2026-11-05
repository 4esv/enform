# Realtime protocol schemas

One `v<N>.json` for each protocol version (MVP.md 9.1, DX-2). The server supports the current version and the previous one (9.3), and tells an older client to reload.

## Version 1

The channel is a WebSocket at `/api/v1/realtime` (RT-1, ADR 0006). The client sends `hello` with the version it speaks; the server answers `welcome` with the principal and the current log position, or `reload` with the versions it supports. The client subscribes to an instance or a flow; the server authorizes the subscription when it is opened (I8) and answers `subscribed` or `refused`. A new event on the log that touches a subscription arrives as `changed`, which carries the seq, the event type and the instance or the flow, and no payload: the client reads through the authorized HTTP API. Presence (RT-2) travels both ways: the client says where it is, the server sends who is there.

The fallbacks carry the same messages one way: Server-Sent Events at `/api/v1/realtime/events?instance=<id>` or `?flow=<slug>` sends `welcome`, `changed` and `presence`; polling reads `GET /api/v1/log?after=<seq>` and derives the changes itself; offline sends nothing and the interface says so.

`tools/realtime-schema.test.ts` validates one example of every message against the schema.
