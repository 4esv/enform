# 0004: Operation and event model

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | I1, I4, I6, I14, DF-2, D3, D6 |

## Context

Invariant I1 makes every change an operation with an ID that the client creates, so that applying an operation two times has the same result as one time. I4 keeps the log append-only, forbids the engine to update or delete events except for a redaction (D5), and lets the engine rebuild all derived state from the log. I6 requires determinism: the clock and the ID generator are injected, and no code reads the system clock directly. I14 makes every change that affects behavior an attributed, versioned operation on the log, covering definitions, connectors, grants, teams, templates and settings. DF-2 makes publication create an immutable version with a content hash. D3 makes the operation log on the server canonical, with files as a projection of it. D6 makes an undo of a completed step a compensating event that the engine adds, never a delete. Section 9.3 states that the engine never rewrites an event, that a changed event shape gets a new type version, and that an upcaster converts old events when the engine reads them. The glossary defines the Operation, the Event and the Log as the single sequence of all events in one global order. Milestone 0.1.0 requires the log and the operation model (I1, I4, I6, I14), and section 11 requires this ADR.

## Decision

Every change is an operation with a client-created UUIDv7 ID, applied idempotently by the engine. The engine appends operations and their events to a single append-only log in one global order assigned by a monotonic sequence number from a single writer. Derived state is rebuilt from the log for 0.1.0, and event schema changes use new type versions with read-time upcasters.

## Alternatives

- **Server-assigned operation IDs.** Rejected because I1 requires the client to create the ID, so that a retry is idempotent without the engine deduplicating on a server sequence.
- **Timestamp-based global order.** Rejected because timestamps can collide, and I6 requires an injected deterministic source; a monotonic sequence number from a single writer is unambiguous.
- **In-place event migration, which rewrites stored events.** Rejected because section 9.3 forbids rewriting; upcasters convert old events on read instead.

## Consequences

Easier: idempotency (I1), a deterministic rebuild from the log (I4 and I6), and complete attribution of every behavior-affecting change (I14).

Harder: the log grows and the rebuild cost grows with it, which snapshots will address later.

Constraint: events are immutable, and schema evolution is only by new type versions plus read-time upcasters.
