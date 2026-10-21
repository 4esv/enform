# 0013: Store operations in PostgreSQL and read state from a projection

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-20 |
| Refs | I1, I2, I4, I5, SE-5, DE-2, DE-3, DE-5, ADR 0003, ADR 0004 |

## Context

ADR 0003 makes PostgreSQL the only datastore and job queue. I2 commits a state change and the side effects that it causes in one transaction. I4 keeps the log append-only and lets the engine rebuild all derived state from it. I5 forbids blocking locks and serializes only step completion, with an optimistic version check. SE-5 makes timers durable jobs that the engine creates and cancels in the same transaction as their task. ADR 0004 fixes the record: an operation with a client-created UUIDv7 ID, appended to one log in one global order, and derived state rebuilt from that log for 0.1.0.

Today the engine is pure and the only server is the test harness in `tools/harness/server.ts`, which keeps `State` in memory behind `apply`. Nothing is durable, so nothing survives a restart, no transaction spans a state change and its side effects, and no rebuild can be demonstrated against a real database. DE-2, DE-3 and DE-5 also need a migration path, a backup and a restore that operate on actual tables.

## Decision

One PostgreSQL database. An append-only `events` table holds the log: `seq` as an identity primary key, a unique `operation_id`, the `type`, the `at` time as a bigint from the injected clock, the `actor`, and the `payload` as JSONB. An operation is applied with `INSERT ... ON CONFLICT (operation_id) DO NOTHING`, so a retry writes nothing and is a no-op (I1).

Read-model tables hold current state: flows and versions, instances and tasks, grants, teams and members, principals (the profile cache), outbox, timers, sessions, and seed markers. Each row carries the `seq` that it was built from. A write appends the event, updates the projections and inserts the outbox and the timer rows in one transaction (I2, SE-5). Reads answer from the projections, and the engine authorizes every read (I8).

`enform admin rebuild` truncates the projections and folds the event log in order, and a rebuild must reproduce the same projections (I4). `instances.version` is the last applied `seq`, and a completion updates with `WHERE version = $expected` (I5).

Migrations are embedded, versioned SQL files with a `schema_migrations` table, each applied in one transaction by `enform migrate` (ADR 0011). There is no ORM: a thin SQL layer over the `pg` driver, with typed row mappers. The driver choice is recorded here.

Engine timestamps come from the injected clock. The database `now()` serves operational metadata only, never a decision (I6).

A seeded operation carries a `seed` marker. `enform seed clear` appends a `seed.cleared@1` event, and the projections exclude the cleared seed records; the event log keeps them (I4). Sessions are operational state, not event-sourced.

## Alternatives

- **Rebuild on every read, with no projections.** Rejected. The inbox and the timeline read current state on each request, so a fold over the whole log would make the read cost grow with the log (I5, A1).
- **A separate event store or a message broker, such as EventStoreDB, Kafka or Redis.** Rejected by ADR 0003. I2 requires the state change and its side effects to commit in one transaction, and SE-5 requires a timer row to commit with its task.
- **An ORM.** Rejected. The schema is small, the SQL is the contract that the rebuild, the backup and the migration depend on, and typed row mappers already give the types at the boundary.
- **Deleting the events of a cleared seed.** Rejected by I4. Clearing a seed is a new event, and the log keeps the record of what was seeded.
- **Storing session data or tokens in the event log.** Rejected. A session is operational state that expires and is revoked, not an attributed change to the organization, and the log must stay a record of facts (I4, I14).
- **Deriving `seq` from a timestamp.** Rejected by ADR 0004. The sequence is the single global order that the rebuild and the version check depend on.

## Consequences

- Easier: the state change, the side effects, the outbox rows and the timer rows commit together, a retry is harmless, and a rebuild proves that the log is the source of truth.
- Harder: migrations, a rebuild path, and integration tests that need a real PostgreSQL. Backup and restore procedures become part of the release (DE-5), and `doctor` must check the database and the migration state.
- Constraint: a new dependency, the `pg` driver, and every projection must be derivable from the log alone. A table that cannot be rebuilt from the log is a second source of truth, which I4 and D3 forbid.
