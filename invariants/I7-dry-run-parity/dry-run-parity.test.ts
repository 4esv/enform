// Issue #13, I7, A6, DR-1 to DR-4: the dry-run parity oracle.
//
// I7: dry runs and live runs use the same code path. Only the side-effect sink
// and the clock are different. The same scenarios run in both modes and must
// give the same side-effect intents. A6: a dry run creates no permanent
// record. The oracle below states that as a check over a run of steps, so a
// story run can call it after its own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState } from '../../engine/apply.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import { createOutboxOperation, type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import {
  type RunResult,
  type RunSources,
  runSteps,
  type Sources,
  type Step,
} from '../../engine/run.js'

/** A fixed Unix-millisecond time for the live run. The clock is injected (I6). */
const NOW = 1_700_000_000_000

/** A different time for the dry run: DR-4 simulates the clock, and the intents must not change. */
const DRAFT_NOW = 1_700_000_600_000

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

/** A fresh pair of injected sources that read the given time. Two calls share no state. */
function sources(now: number): Sources {
  const random = counterBytes()
  return { clock: () => now, ids: () => uuidv7(now, random) }
}

/** One side effect that a state change causes: a task-assigned email to send (SE-1, SE-2). */
const ASSIGNED: OutboxEntry = {
  operation: 'send-task-assigned',
  target: 'connector-smtp',
  payload: { to: 'person-dana', step: 'approve' },
}

/** A second side effect, from a later step, so that the order is observable (I7). */
const REMINDER: OutboxEntry = {
  operation: 'send-task-reminder',
  target: 'connector-smtp',
  payload: { to: 'person-dana', step: 'approve' },
}

/**
 * The scenario that the checks run. The first step changes state and causes no
 * side effect, the second causes an email, the third causes a reminder.
 */
const STEPS: readonly Step[] = [
  { type: 'flow.created@1', payload: { name: 'pilot' } },
  {
    type: 'task.assigned@1',
    payload: { step: 'approve' },
    actor: 'person-ana',
    outbox: [ASSIGNED],
  },
  { type: 'timer.fired@1', payload: { step: 'approve' }, outbox: [REMINDER] },
]

/**
 * The I7 oracle. Run the same steps dry and live and check that both modes
 * produce the side-effect intents of the steps, in step order (I7). A live run
 * commits those intents with the state change that caused them (I2), so they
 * are in the outbox of its log. A dry run creates no permanent record (A6): it
 * writes no event. The two runs take different clocks and share no source
 * (DR-4), so parity does not rest on one mode reading the other's clock.
 */
function assertDryRunParity(
  steps: readonly Step[],
  run: (steps: readonly Step[], sources: RunSources) => RunResult = runSteps
): void {
  const expected = steps.flatMap((step) => step.outbox ?? [])
  expect(expected.length, 'the scenario declares no side effect to compare').toBeGreaterThan(0)
  const live = run(steps, { ...sources(NOW), sink: 'live' })
  const dry = run(steps, { ...sources(DRAFT_NOW), sink: 'dry' })
  expect(live.intents, 'the live run did not produce the side effects of its steps').toEqual(
    expected
  )
  expect(dry.intents, 'the dry run and the live run give different intents').toEqual(expected)
  expect(outboxOf(live.state.log), 'the live run did not commit its side effects').toEqual(expected)
  expect(dry.state.log, 'the dry run wrote an event').toEqual([])
  expect(outboxOf(dry.state.log), 'the dry run committed a side effect').toEqual([])
}

test.fails('#13 the same steps dry and live give the same side-effect intents (I7)', () => {
  assertDryRunParity(STEPS)
})

/**
 * The deliberate violation of the check above: a run whose dry sink drops the
 * last intent, so a dry run and a live run do not agree, though both use the
 * same code path up to the sink (I7). The oracle must fail on it, and
 * `test.fails` asserts that failure.
 */
function runWithLossyDrySink(steps: readonly Step[], sources: RunSources): RunResult {
  let state = emptyState
  const intents: OutboxEntry[] = []
  for (const step of steps) {
    const entries = step.outbox ?? []
    intents.push(...entries)
    if (sources.sink === 'live') {
      const operation = createOutboxOperation(step.type, step.payload, entries, sources, step.actor)
      state = apply(operation, state)
    }
  }
  if (sources.sink === 'dry') return { state, intents: intents.slice(0, -1) }
  return { state, intents }
}

test.fails('#13 the oracle fails when the dry sink drops an intent (I7)', () => {
  assertDryRunParity(STEPS, runWithLossyDrySink)
})
