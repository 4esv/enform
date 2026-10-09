// Issue #8, I2, I4, A2, A4, ADR 0003: the transactional outbox oracle.
//
// I2: a state change and the side effects that it causes commit in one
// database transaction. Both commit, or neither commits. This engine is
// in-memory, and the append-only log is the transaction (I4, ADR 0003): the
// operation that changes state carries the side effects that it causes, so one
// `apply` writes both into one event. The oracle below states that as a check
// over any end state. A story run can call it after its own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState, rebuild, type State } from '../../engine/apply.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import { createOperation, type Log, type Operation } from '../../engine/operation.js'
import {
  createOutboxOperation,
  type OutboxEntry,
  outboxOf,
  outboxOfEvent,
} from '../../engine/outbox.js'

/** A fixed Unix-millisecond time. The clock is injected, so this is the only time (I6). */
const NOW = 1_700_000_000_000

/** A deterministic byte source, so that the same run gives the same operation IDs. */
function counterBytes(): RandomBytes {
  let next = 0
  return (length) => {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      next += 1
      bytes[i] = next % 256
    }
    return bytes
  }
}

/** One side effect that a state change causes: a task-assigned email to send (SE-1, SE-2). */
const EMAIL: OutboxEntry = {
  operation: 'send-task-assigned',
  target: 'connector-smtp',
  payload: { to: 'person-dana', step: 'approve' },
}

/**
 * An end state with two applied operations: the first changes state and causes
 * one side effect, the second changes state and causes none. The outbox of the
 * log is the side effect of the first operation alone (I2).
 */
function sample(): { readonly state: State; readonly entries: readonly OutboxEntry[] } {
  const random = counterBytes()
  const deps = { clock: () => NOW, ids: () => uuidv7(NOW, random) }
  const operations: Operation[] = [
    createOutboxOperation('task.assigned@1', { step: 'approve' }, [EMAIL], deps, 'person-ana'),
    createOperation('step.completed@1', { step: 'approve' }, deps),
  ]
  const state = operations.reduce((acc, operation) => apply(operation, acc), emptyState)
  return { state, entries: [EMAIL] }
}

/**
 * The I2 oracle. Check any end state: the outbox that the engine derives holds
 * exactly the side effects that the committed events carry, each in the event
 * of the state change that caused it, so a state change and its side effects
 * are present together or absent together (I2). A rebuild from the log
 * reproduces the outbox (I4). The oracle takes any end state, not only a fresh
 * one, so a story run can call it after its own run (MVP.md 11.4).
 */
function assertTransactionalOutbox(
  state: State,
  readOutbox: (log: Log) => readonly OutboxEntry[] = outboxOf
): void {
  const committed = state.log.flatMap(outboxOfEvent)
  expect(readOutbox(state.log), 'the outbox is not the side effects of the events').toEqual(
    committed
  )
  expect(readOutbox(rebuild(state.log).log), 'a rebuild does not reproduce the outbox').toEqual(
    committed
  )
}

test('#8 a state change and its side effects share one event (I2)', () => {
  const { state, entries } = sample()
  expect(outboxOf(state.log)).toEqual(entries)
  assertTransactionalOutbox(state)
})

/**
 * The deliberate violation of the check above: an outbox in a second store,
 * decoupled from the log. It can hold a side effect whose state change never
 * committed, so a side effect commits when its state change does not (I2). The
 * oracle must fail on it, and `test.fails` asserts that failure.
 */
const ORPHAN: OutboxEntry = {
  operation: 'send-task-assigned',
  target: 'connector-smtp',
  payload: { to: 'person-bao', step: 'register' },
}

function decoupledOutbox(_log: Log): readonly OutboxEntry[] {
  return [ORPHAN]
}

test.fails('#8 the oracle fails when the outbox is decoupled from the log (I2)', () => {
  const { state } = sample()
  assertTransactionalOutbox(state, decoupledOutbox)
})
