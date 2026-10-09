// Issue #7, I1, I4, I6, ADR 0004: the idempotent operation oracle.
//
// I1: each change is an operation with an ID that the client creates. If the
// engine applies an operation two times, the result is the same as one time.
// The oracle below states that as a check over any end state. A story run can
// call it after its own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import { createOperation, type Operation } from '../../engine/operation.js'

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

/** An end state with three applied operations. */
function endState(): State {
  const random = counterBytes()
  const deps = { clock: () => NOW, ids: () => uuidv7(NOW, random) }
  const operations = [
    createOperation('flow.created@1', { name: 'pilot' }, deps),
    createOperation('flow.renamed@1', { name: 'pilot flow' }, deps),
    createOperation('step.added@1', { step: 'chair' }, deps),
  ]
  return operations.reduce((state, operation) => apply(operation, state), emptyState)
}

/** The operations that a state's log records. An event carries its operation. */
function replayOperations(state: State): Operation[] {
  return state.log.map((event) => ({
    id: event.operationId,
    type: event.type,
    at: event.at,
    payload: event.payload,
  }))
}

/**
 * The I1 oracle. Replay every operation that the state's log records, against
 * the state itself. I1 (MVP.md 4) says that must not change the result. It
 * takes any end state, not only a fresh one.
 */
function assertIdempotent(
  state: State,
  applyOperation: (operation: Operation, state: State) => State = apply
): void {
  let replayed = state
  for (const operation of replayOperations(state)) {
    replayed = applyOperation(operation, replayed)
  }
  expect(replayed).toEqual(state)
}

test('#7 a replay of the log does not change the state (I1)', () => {
  const state = endState()
  expect(state.log).toHaveLength(3)
  assertIdempotent(state)
})

/**
 * The deliberate violation of the check above: an apply that does not test the
 * operation ID, so a second application appends a second event. The oracle
 * must fail on it, and `test.fails` asserts that failure.
 */
function applyWithoutIdCheck(operation: Operation, state: State): State {
  const event = {
    seq: state.log.length + 1,
    operationId: operation.id,
    type: operation.type,
    at: operation.at,
    payload: operation.payload,
  }
  return { applied: state.applied, log: [...state.log, event] }
}

test.fails('#7 the oracle fails when a second application changes the state', () => {
  assertIdempotent(endState(), applyWithoutIdCheck)
})
