// Issue #8, I2, I4, A2, A4, SE-1, ADR 0003: the transactional outbox.
//
// I2: a state change and the side effects that it causes commit in one
// database transaction. Both commit, or neither commits. This engine is
// in-memory, and the append-only log is the transaction (I4, ADR 0003): the
// operation that changes state also carries the side effects that it causes,
// so `apply` writes both into one event (apply.ts). A state change and its
// side effects are therefore present in the log together or absent together.
// The outbox is derived state, a projection of the log; a worker would deliver
// it at least once, later (SE-1, I3). This model does not run the worker.
//
// Scaffolding for #8: the types below are the outbox that the oracle checks.
// The three functions are stubs, so the first check of the suite fails until
// the implementation lands in the second commit.

import {
  type ActorId,
  createOperation,
  type Event,
  type Log,
  type Operation,
  type OperationDeps,
} from './operation.js'

/**
 * One side effect (MVP.md 3, SE-1): an action outside enform that a worker
 * delivers from the outbox. `operation` names the connector operation,
 * `target` names the connector or resource to call, and `payload` is what to
 * send.
 */
export type OutboxEntry = {
  readonly operation: string
  readonly target: string
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * Create the operation that records one state change and the side effects that
 * it causes (I2, A2). `change` is the payload of the state change, and `outbox`
 * are the outbox entries that it causes. Stub: the operation does not carry its
 * side effects yet, so the first check of the suite fails until #8 lands.
 */
export function createOutboxOperation(
  type: string,
  change: Readonly<Record<string, unknown>>,
  _outbox: readonly OutboxEntry[],
  deps: OperationDeps,
  actor?: ActorId
): Operation {
  return createOperation(type, change, deps, actor)
}

/**
 * The outbox entries that one event carries (I2). They are part of the event
 * itself, so the state change and its side effects share one commit. Stub: the
 * read lands with #8.
 */
export function outboxOfEvent(_event: Event): readonly OutboxEntry[] {
  return []
}

/**
 * The outbox as derived state (I4): every side effect that the log carries, in
 * log order. Stub: the projection lands with #8.
 */
export function outboxOf(_log: Log): readonly OutboxEntry[] {
  return []
}
