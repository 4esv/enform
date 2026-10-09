import { expect, test } from 'vitest'
import { evaluate } from '../../engine/condition.js'
import type { RunSources } from '../../engine/run.js'
import { isStepSkipped, runFlow, STEP_SKIPPED } from '../../engine/workflow.js'
import { chairSkipWhen, chairStep, draft, largeOverload, smallOverload } from './scenario.js'

// The principal who advances the flow: the advisor approves, so the advisor is
// the one who records the skip (S05, I14).
const ADVISOR = 'user:okafor'

// The injected sources of a run (I6): the clock is a fixed time and the IDs are
// `op-N`, so the same run gives the same operation IDs. Two runs share no
// source, so parity does not rest on one run reading the other's.
function sources(sink: 'live' | 'dry'): RunSources {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
    ids: () => {
      next += 1
      return `op-${next}`
    },
    sink,
  }
}

// Issue #42: a step is skipped when its condition is true (S05, WF-1). The
// chair step carries `overload_credits <= 2`, a JSON Logic expression (FM-5):
// at two credits the chair is skipped and a live run records the skip on the
// timeline, at four it stays active. Dry and live share one run path, so they
// decide the same route (I7). The decision is deterministic (I6).

test('#42 a true skip condition skips the chair step and the live run records it (S05)', () => {
  // The fixture carries the condition, and the evaluator reads the data (FM-5).
  expect(chairStep.skipWhen).toEqual(chairSkipWhen)
  expect(evaluate(chairSkipWhen, smallOverload)).toBe(true)
  expect(isStepSkipped(chairStep, smallOverload)).toBe(true)

  // (a) overload_credits = 2: the chair is skipped, and a live run records one
  // attributed step.skipped@1 event (WF-1, I14).
  const liveSmall = runFlow(draft, smallOverload, sources('live'), ADVISOR)
  expect(liveSmall.route.active).toEqual(['request', 'advisor', 'registrar'])
  expect(liveSmall.route.skipped).toEqual([{ step: 'chair', condition: chairSkipWhen }])
  expect(liveSmall.state.log).toHaveLength(1)
  const [event] = liveSmall.state.log
  expect(event.type).toBe(STEP_SKIPPED)
  expect(event.actor).toBe(ADVISOR)
  expect(event.payload).toMatchObject({ step: 'chair', condition: chairSkipWhen })

  // (b) overload_credits = 4: the condition is false, so the chair is active
  // and a live run records no skip (WF-1).
  expect(evaluate(chairSkipWhen, largeOverload)).toBe(false)
  expect(isStepSkipped(chairStep, largeOverload)).toBe(false)
  const liveLarge = runFlow(draft, largeOverload, sources('live'), ADVISOR)
  expect(liveLarge.route.active).toEqual(['request', 'advisor', 'chair', 'registrar'])
  expect(liveLarge.route.skipped).toEqual([])
  expect(liveLarge.state.log).toEqual([])

  // (c) I7: dry and live decide the same route for both fixtures, and the dry
  // run writes no event (A6).
  const drySmall = runFlow(draft, smallOverload, sources('dry'), ADVISOR)
  const dryLarge = runFlow(draft, largeOverload, sources('dry'), ADVISOR)
  expect(drySmall.route).toEqual(liveSmall.route)
  expect(dryLarge.route).toEqual(liveLarge.route)
  expect(drySmall.state.log).toEqual([])
  expect(dryLarge.state.log).toEqual([])
})
