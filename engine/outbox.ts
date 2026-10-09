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
 * The reserved payload key that carries an operation's side effects (I2). An
 * operation that changes state carries the outbox entries that it causes under
 * this key, so one `apply` writes the state change and its side effects into
 * one event. A state-change payload does not use the key.
 */
const OUTBOX_KEY = 'outbox'

/**
 * Create the operation that records one state change and the side effects that
 * it causes (I2, A2). `change` is the payload of the state change, and `outbox`
 * are the outbox entries that it causes. The operation carries both in one
 * payload, so the one event that `apply` appends holds both: the state change
 * and its side effects commit together or not at all (I2).
 */
export function createOutboxOperation(
  type: string,
  change: Readonly<Record<string, unknown>>,
  outbox: readonly OutboxEntry[],
  deps: OperationDeps,
  actor?: ActorId
): Operation {
  return createOperation(type, { ...change, [OUTBOX_KEY]: outbox }, deps, actor)
}

/**
 * The outbox entries that one event carries (I2). They are part of the event
 * itself, so the state change and its side effects share one commit (I2).
 */
export function outboxOfEvent(event: Event): readonly OutboxEntry[] {
  return readOutbox(event.payload[OUTBOX_KEY])
}

/**
 * The outbox as derived state (I4): every side effect that the log carries, in
 * log order. The log is the single source of truth, so the outbox is a
 * projection of it and never a second store (I2): reading the outbox reads no
 * separate state, so a committed state change and its side effects are always
 * both visible (I2). A rebuild from the log reproduces the outbox (I4).
 */
export function outboxOf(log: Log): readonly OutboxEntry[] {
  return log.flatMap(outboxOfEvent)
}

/** Read the reserved outbox key. An absent key means the event caused no side effect. */
function readOutbox(value: unknown): readonly OutboxEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`outbox: the ${OUTBOX_KEY} key must be an array`)
  }
  return value as readonly OutboxEntry[]
}
