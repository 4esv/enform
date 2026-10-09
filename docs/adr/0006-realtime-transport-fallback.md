# 0006: Realtime transport and fallback

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | RT-1, DX-2, A4 |

## Context

enform runs over networks that are not reliable. RT-1 sets WebSocket as the primary transport, with a fallback order of Server-Sent Events, then polling, then offline, and requires the interface to always show the current mode. DX-2 requires a published message schema for the realtime protocol, with the client and the server agreeing the protocol version in the handshake. A4 requires that a screen shows the true state, or marks it pending, stale, offline or conflicted, and never shows an unconfirmed state as confirmed. Section 9.1 lists the realtime protocol as a public surface, versioned by an integer protocol version agreed in the handshake at `schemas/realtime/v<N>.json`, and section 9.3 requires the server to support the current protocol version and the previous one, and to tell older clients to reload.

## Decision

Use WebSocket as the primary realtime transport. The client falls back to Server-Sent Events, then polling, then offline, and the interface always shows the current mode. The protocol is a published message schema, and the client and the server agree its version in the handshake.

## Alternatives

- **WebSocket only, with no fallback.** Rejected. A4 and the "no work is lost on a bad network" property require a path that still works when WebSocket is blocked or dropped.
- **Server-Sent Events as the primary transport.** Rejected. SSE is one-directional and cannot carry the bidirectional operations that RT-1 needs, such as presence and optimistic acknowledgements. SSE is kept only as the first fallback.
- **Long-polling only.** Rejected. It adds latency and request overhead for presence and shared views, and it gives no upgrade path to a bidirectional channel.

## Consequences

- Easier: one published schema describes the protocol, and the transport mode is honest and always visible.
- Harder: the client implements four transport modes, plus reconnection and the version handshake.
- Constraint: the realtime surface is versioned, and the server must support the current and the previous protocol version.
