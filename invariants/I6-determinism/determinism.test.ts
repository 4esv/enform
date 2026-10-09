// Issue #12, I6, A6, ADR 0004: the determinism oracle.
//
// I6: the same definition, events, clock and ID source give the same result.
// The clock and the ID generator are injected, and no code reads the system
// clock directly. The oracle below states that as a check over any end state,
// so a story run can call it after its own run (MVP.md 11.4).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import { createOperation } from '../../engine/operation.js'
import { deterministicRun, type Sources, type Step } from '../../engine/run.js'

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

/** A fresh pair of injected sources. Two calls give equal values, and share no state. */
function sources(): Sources {
  const random = counterBytes()
  return { clock: () => NOW, ids: () => uuidv7(NOW, random) }
}

/** The sequence that the checks run. The same steps and sources must give the same result. */
const STEPS: readonly Step[] = [
  { type: 'flow.created@1', payload: { name: 'pilot' } },
  { type: 'flow.renamed@1', payload: { name: 'pilot flow' } },
  { type: 'step.added@1', payload: { step: 'chair' } },
]

/** A byte-exact view of a state: the log, and the applied IDs in order. */
function snapshot(state: State): string {
  return JSON.stringify({ applied: [...state.applied], log: state.log })
}

/**
 * The I6 oracle. Re-run the same steps from the same injected clock and ID
 * source, and check that they reproduce the end state byte for byte (I6). It
 * takes any end state, not only a fresh one, so a story run can call it after
 * its own run (MVP.md 11.4).
 */
function assertDeterministic(
  state: State,
  steps: readonly Step[],
  makeSources: () => Sources = sources,
  run: (steps: readonly Step[], sources: Sources) => State = deterministicRun
): void {
  expect(snapshot(run(steps, makeSources()))).toBe(snapshot(state))
}

test('#12 the same steps and injected sources give the same state (I6)', () => {
  const state = deterministicRun(STEPS, sources())
  expect(state.log).toHaveLength(3)
  assertDeterministic(state, STEPS)
})

/**
 * The deliberate violation of the check above: a run that ignores the injected
 * ID source and takes its IDs from a module counter, so a second run differs.
 * The oracle must fail on it, and `test.fails` asserts that failure.
 */
let mutatedId = 0
function runIgnoringSources(steps: readonly Step[]): State {
  let state = emptyState
  for (const step of steps) {
    const operation = createOperation(step.type, step.payload, {
      clock: () => NOW,
      ids: () => {
        mutatedId += 1
        return `mutated-${mutatedId}`
      },
    })
    state = apply(operation, state)
  }
  return state
}

test.fails('#12 the oracle fails when a run ignores its injected source', () => {
  const state = runIgnoringSources(STEPS)
  assertDeterministic(state, STEPS, sources, runIgnoringSources)
})

/** The engine sources, with comments removed so that prose about a call does not count as one. */
function engineCode(): { readonly file: string; readonly code: string }[] {
  const engine = join(import.meta.dirname, '..', '..', 'engine')
  return readdirSync(engine)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      file: name,
      code: readFileSync(join(engine, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, ''),
    }))
}

/** A direct call to the system clock or a random source. I6 forbids all of them. */
const SYSTEM_SOURCE = /\bDate\.now\b|\bMath\.random\b|\bcrypto\.randomUUID\b/

test('#12 the engine never calls the system clock or a random source (I6)', () => {
  const files = engineCode()
  expect(files.length).toBeGreaterThan(0)
  const offenders = files.filter(({ code }) => SYSTEM_SOURCE.test(code)).map(({ file }) => file)
  expect(offenders).toEqual([])
})
