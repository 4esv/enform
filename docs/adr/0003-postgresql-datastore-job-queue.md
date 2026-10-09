# 0003: PostgreSQL as the only datastore and job queue

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-10-08 |
| Refs | I2, I4, I5, SE-5, D3 |

## Context

Invariant I2 commits a state change and the side effects that it causes in one database transaction. I4 keeps the event log append-only and lets the engine rebuild all derived state from it. I5 requires that a read or an edit never waits for another user, and serializes only step completion with an optimistic version check. SE-5 makes timers durable jobs that the engine creates and cancels in the same transaction as their task. D3 makes the operation log on the server canonical; files are a projection of it. The glossary defines the Operation, the Event, the Log and the Side effect, and the worker executes side effects from the outbox. Milestone 0.1.0 names PostgreSQL.

## Decision

PostgreSQL is the only datastore and job queue. One PostgreSQL database holds the append-only operation log, the derived state, the transactional outbox and the durable timer jobs, so a state change and its side effects commit in one transaction.

## Alternatives

- **A separate event store, such as EventStoreDB or Kafka, alongside PostgreSQL.** Rejected. I2 requires the state and the side effects to commit in one transaction, and two stores cannot do that atomically. I5 forbids the blocking coordination that a commit across two stores would need.
- **An external job queue, such as Redis or a dedicated queue broker.** Rejected. SE-5 requires timers to be durable and to be created and cancelled in the same transaction as their task, which a second store cannot guarantee.
- **A different relational engine, such as MySQL.** Rejected. The milestone and the issue fix PostgreSQL, and its JSON support and row-level optimistic concurrency serve I4 and I5 directly.

## Consequences

- One transactional boundary covers the state, the outbox and the timer jobs (I2).
- One backup and operational surface.
- The engine can rebuild all derived state from the log (I4).
- The job queue runs inside the same store as the log and the state, so a job and its trigger commit together (SE-5).
- Write throughput is bounded by one database. It grows with partitioning later.
- No second datastore may enter the architecture without a new ADR that supersedes this one.
