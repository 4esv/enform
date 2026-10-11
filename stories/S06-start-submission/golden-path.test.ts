import { expect, test } from 'vitest'
import type { Operation } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import {
  ASSIGNMENT_EMAIL,
  EMAIL_CONNECTOR,
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { runGolden } from '../../tools/harness/runner.js'
import { goldenView, stepOperation } from '../../tools/harness/scenario.js'
import { flow, golden, resolve, samData, samGrants } from './scenario.js'

/** Sam, the signed-in principal who starts the submission (S06, ID-2). */
const SAM = 'user:sam'

/** Dr. Okafor, the advisor who receives the assignment email (S06, SE-1). */
const OKAFOR = 'user:okafor'

/** The runner's injected sources (I6): the clock is the step index and the IDs are `op-N`. */
function depsFor(index: number): { clock: () => number; ids: () => string } {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

/** The golden path through S06 (start then submit), as the engine's own operations (I6). */
function submissionOperations(): readonly Operation[] {
  const started = startInstance(flow, samData, SAM, depsFor(0), resolve, samGrants)
  const submitted = submitInstance(started.instance, SAM, depsFor(1), samData)
  return [started.operation, submitted.operation]
}

// Issue #179: the golden path of S06 runs through the harness runner in api
// mode. The scenario's steps are the engine's own operations for the runner's
// injected sources (I6), the run reaches the golden end state (I4), the submit
// records its assignment email as a side effect (I2, SE-1), and both payloads
// carry the values that the form holds (FM-7). Marked expected to fail until
// the golden scenario is exported.

test('#179 the golden path of S06 runs through the runner in api mode (S06)', async () => {
  expect(submissionOperations()).toEqual(
    golden.steps.map((step, index) => stepOperation(step, index))
  )

  await runGolden(golden)

  const view = goldenView(golden)
  expect(view.log.map((event) => event.type)).toEqual([INSTANCE_STARTED, INSTANCE_SUBMITTED])
  expect(outboxOf(view.log)).toEqual([
    {
      operation: ASSIGNMENT_EMAIL,
      target: EMAIL_CONNECTOR,
      payload: { to: OKAFOR, step: 'advisor' },
    },
  ])
  expect(view.log[0].payload).toMatchObject({ values: samData })
  expect(view.log[1].payload).toMatchObject({ values: samData, submitted: true })
})
