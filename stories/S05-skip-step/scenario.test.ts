import { expect, test } from 'vitest'
import { STEP_COMPLETED } from '../../engine/action.js'
import { evaluate } from '../../engine/condition.js'
import { instanceOf } from '../../engine/instances.js'
import type { RunSources } from '../../engine/run.js'
import { trackerOf } from '../../engine/tracker.js'
import { isStepSkipped, routeAfter, runFlow } from '../../engine/workflow.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ADVISOR_STEP,
  definitionV1,
  LIN,
  OKAFOR,
  REGISTRAR_STEP,
  REQUEST_STEP,
} from '../example-flow.js'
import {
  CHAIR,
  chairSkipWhen,
  chairStep,
  golden,
  LARGE_ID,
  largeOverload,
  SMALL_ID,
  smallOverload,
} from './scenario.js'

// Issue #42: a step is skipped when its condition is true (S05, WF-1). The
// chair step carries `overload_credits <= 2`, a JSON Logic expression (FM-5):
// at two credits the advisor's approval routes straight to the registrar and
// records the skip with its condition, at four credits the chair is active.
// Dry and live share one routing (I7), and the decision is deterministic (I6).

/** The injected sources of a dry run (I6): a fixed clock and `op-N` ids, and the dry sink (A6). */
function dry(): RunSources {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
    ids: () => {
      next += 1
      return `op-${next}`
    },
    sink: 'dry',
  }
}

test('#42 the S05 golden path runs in api, cli and dry mode: a true condition skips the chair and the timeline records why (S05)', {
  timeout: 60_000,
}, async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // (a) overload_credits = 2: the approval of the advisor step skipped the
  // chair and routed to the registrar. The completion records the skip and
  // its condition (WF-1, I4), so the tracker shows the reason (VT-2).
  const small = instanceOf(state.log, SMALL_ID)
  if (small === undefined) throw new Error('the small request is not projected')
  expect(small.currentStep).toBe(REGISTRAR_STEP)
  const smallApproval = state.log.find(
    (event) => event.type === STEP_COMPLETED && event.payload.instanceId === SMALL_ID
  )
  expect(smallApproval?.actor).toBe(OKAFOR)
  expect(smallApproval?.payload).toMatchObject({
    step: ADVISOR_STEP,
    currentStep: REGISTRAR_STEP,
    skipped: [{ step: CHAIR, condition: chairSkipWhen }],
  })
  const smallTracker = trackerOf(small, definitionV1, state.log)
  expect(smallTracker.map((entry) => [entry.key, entry.state])).toEqual([
    [REQUEST_STEP, 'completed'],
    [ADVISOR_STEP, 'completed'],
    [CHAIR, 'skipped'],
    [REGISTRAR_STEP, 'unopened'],
  ])
  expect(smallTracker[2].condition).toEqual(chairSkipWhen)

  // (b) overload_credits = 4: the condition is false, the chair is active,
  // and Dr. Lin holds it through the CS-Chairs group (AS-4).
  const large = instanceOf(state.log, LARGE_ID)
  if (large === undefined) throw new Error('the large request is not projected')
  expect(large.currentStep).toBe(CHAIR)
  expect(large.holder).toBe(LIN)
  expect(large.assignees).toContainEqual({
    step: CHAIR,
    target: { group: 'CS-Chairs' },
    members: [LIN],
  })
  const largeApproval = state.log.find(
    (event) => event.type === STEP_COMPLETED && event.payload.instanceId === LARGE_ID
  )
  expect(largeApproval?.payload).toMatchObject({ currentStep: CHAIR, skipped: [] })
  expect(trackerOf(large, definitionV1, state.log).map((entry) => entry.state)).toEqual([
    'completed',
    'completed',
    'opened',
    'not-reached',
  ])
})

test('#42 dry run and live give the same routing for both fixtures (S05)', () => {
  // The fixture carries the condition, and the evaluator reads the data (FM-5).
  expect(chairStep.skipWhen).toEqual(chairSkipWhen)
  expect(evaluate(chairSkipWhen, smallOverload)).toBe(true)
  expect(isStepSkipped(chairStep, smallOverload)).toBe(true)
  expect(evaluate(chairSkipWhen, largeOverload)).toBe(false)
  expect(isStepSkipped(chairStep, largeOverload)).toBe(false)

  // The live route after the advisor step is the one the golden path took
  // (WF-1): past the chair at two credits, into it at four.
  expect(routeAfter(definitionV1, ADVISOR_STEP, smallOverload)).toEqual({
    step: definitionV1.steps[3],
    skipped: [{ step: CHAIR, condition: chairSkipWhen }],
  })
  expect(routeAfter(definitionV1, ADVISOR_STEP, largeOverload)).toEqual({
    step: chairStep,
    skipped: [],
  })

  // I7: a dry run of the flow decides the same route for both fixtures and
  // writes no event (A6, DR-1).
  const drySmall = runFlow(definitionV1, smallOverload, dry(), OKAFOR)
  expect(drySmall.route.active).toEqual([REQUEST_STEP, ADVISOR_STEP, REGISTRAR_STEP])
  expect(drySmall.route.skipped).toEqual([{ step: CHAIR, condition: chairSkipWhen }])
  expect(drySmall.state.log).toEqual([])
  const dryLarge = runFlow(definitionV1, largeOverload, dry(), OKAFOR)
  expect(dryLarge.route.active).toEqual([REQUEST_STEP, ADVISOR_STEP, CHAIR, REGISTRAR_STEP])
  expect(dryLarge.route.skipped).toEqual([])
  expect(dryLarge.state.log).toEqual([])
})
