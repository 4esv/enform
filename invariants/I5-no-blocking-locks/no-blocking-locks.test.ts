// Issue #11, I5, A1, I4, ADR 0004: the no blocking locks oracle.
//
// I5: a read or an edit never waits for another user. Only step completion is
// serialized, with an optimistic version check. This engine never takes a lock
// and never waits: a completion carries the version that it was based on, and
// the engine applies it only when that version is still current. A completion
// on a stale version is rejected at once, and the caller re-reads and retries.
// A read is a pure function of the log, so it is immediate (I4). The oracle
// below states that as a check over any end state. A story run can call it
// after its own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { type CompletionResult, completeStep, version } from '../../engine/concurrency.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import { createOperation, type Operation } from '../../engine/operation.js'

/** A fixed Unix-millisecond time. The clock is injected, so this is the only time (I6). */
const NOW = 1_700_000_000_000

/** A deterministic byte source, so that the same run gives the same operation IDs. */
function counterBytes(start = 0): RandomBytes {
  let next = start
  return (length) => {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      next += 1
      bytes[i] = next % 256
    }
    return bytes
  }
}

/** An end state with two applied operations: a task and its completion (WF-1). */
function sample(): State {
  const random = counterBytes()
  const deps = { clock: () => NOW, ids: () => uuidv7(NOW, random) }
  const operations = [
    createOperation('task.assigned@1', { step: 'approve' }, deps, 'person-ana'),
    createOperation('step.completed@1', { step: 'approve' }, deps, 'person-ana'),
  ]
  return operations.reduce((acc, operation) => apply(operation, acc), emptyState)
}

/** A source of distinct completions, so a completion does not collide with a past one (I1). */
function completions(): () => Operation {
  const random = counterBytes(128)
  const deps = { clock: () => NOW, ids: () => uuidv7(NOW, random) }
  let n = 0
  return () => {
    n += 1
    return createOperation('step.completed@1', { step: 'approve', n }, deps, 'person-ana')
  }
}

/** A completion function as the oracle takes it: `completeStep` or a deliberate violation. */
type CompleteStep = (
  state: State,
  expectedVersion: number,
  completion: Operation
) => CompletionResult

/**
 * The I5 oracle. Check any end state: a completion based on the current
 * version applies and advances the version by one; a completion based on a
 * stale version is rejected at once, and the state is unchanged; a read is
 * pure and immediate, so it returns at once and changes nothing (I5). The
 * engine never waits and never mutates the input state (I4). The oracle takes
 * any end state, not only a fresh one, so a story run can call it after its
 * own run (MVP.md 11.4).
 */
function assertNoBlockingLocks(
  state: State,
  nextCompletion: () => Operation,
  complete: CompleteStep = completeStep
): void {
  const current = version(state)

  const applied = complete(state, current, nextCompletion())
  expect(applied.accepted, 'a completion on the current version is not applied').toBe(true)
  expect(version(applied.state), 'an applied completion does not advance the version').toBe(
    current + 1
  )

  const stale = complete(state, current - 1, nextCompletion())
  expect(stale.accepted, 'a completion on a stale version is not rejected').toBe(false)
  expect(stale.state, 'a rejected completion changed the state').toBe(state)
  expect(version(stale.state), 'a rejected completion advanced the version').toBe(current)

  expect(state.log, 'a completion mutated the input state').toHaveLength(current)
  expect(version(state), 'a read is not stable across calls').toBe(current)
}

test('#11 a completion on the current version applies and a stale one is rejected (I5)', () => {
  assertNoBlockingLocks(sample(), completions())
})

/**
 * The deliberate violation of the check above: a completion that ignores the
 * version and always applies. It accepts a completion that was based on a
 * stale version, so two completions of the same step both apply and one edit
 * waits for the other (I5). The oracle must fail on it, and `test.fails`
 * asserts that failure.
 */
const ignoringVersion: CompleteStep = (state, _expectedVersion, completion) => ({
  accepted: true,
  state: apply(completion, state),
})

test.fails('#11 the oracle fails when a completion ignores the version (I5)', () => {
  assertNoBlockingLocks(sample(), completions(), ignoringVersion)
})
