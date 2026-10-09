// Issue #10, I4, A2, A8, ADR 0004: the append-only log oracle.
//
// I4: the engine does not update or delete events. The only exception is a
// redaction event (D5). The engine can rebuild all derived state from the log.
// The oracle below states that as a check over any end state. A story run can
// call it after its own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState, rebuild, type State } from '../../engine/apply.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import { createOperation, type Log, type Operation } from '../../engine/operation.js'

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

/** An end state with three applied operations, and the operation that follows it. */
function sample(): { readonly state: State; readonly next: Operation } {
  const random = counterBytes()
  const deps = { clock: () => NOW, ids: () => uuidv7(NOW, random) }
  const operations = [
    createOperation('flow.created@1', { name: 'pilot' }, deps),
    createOperation('flow.renamed@1', { name: 'pilot flow' }, deps),
    createOperation('step.added@1', { step: 'chair' }, deps),
  ]
  const state = operations.reduce((acc, operation) => apply(operation, acc), emptyState)
  return { state, next: createOperation('step.added@1', { step: 'table' }, deps) }
}

/**
 * The I4 oracle. Append one operation to any end state, then check that the
 * engine kept the log append-only. A rebuild replays the log and reproduces
 * the state (I4), and the append updates or deletes no past event (I4). The
 * oracle takes any end state, not only a fresh one, so a story run can call it
 * after its own run (MVP.md 11.4).
 */
function assertAppendOnly(
  state: State,
  next: Operation,
  rebuildFrom: (log: Log) => State = rebuild
): void {
  const before = [...state.log]
  const grown = apply(next, state)
  expect(rebuildFrom(grown.log)).toEqual(grown)
  expect(state.log).toEqual(before)
  expect(grown.log.slice(0, before.length)).toEqual(before)
  expect(grown.log).toHaveLength(before.length + 1)
}

test('#10 an append keeps the past events and a rebuild reproduces the state (I4)', () => {
  const { state, next } = sample()
  expect(state.log).toHaveLength(3)
  assertAppendOnly(state, next)
})

/**
 * The deliberate violation of the check above: a rebuild that drops the last
 * event, so the rebuilt log is shorter than the log it was given. The oracle
 * must fail on it, and `test.fails` asserts that failure.
 */
function rebuildDroppingLast(log: Log): State {
  return rebuild(log.slice(0, -1))
}

test.fails('#10 the oracle fails when a rebuild drops an event', () => {
  const { state, next } = sample()
  assertAppendOnly(state, next, rebuildDroppingLast)
})
