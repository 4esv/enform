import { isDeepStrictEqual } from 'node:util'
import { expect, test } from 'vitest'
import { instanceOf } from '../../engine/instances.js'
import { DRAFT_EDITED, INSTANCE_SUBMITTED } from '../../engine/submission.js'
import { offlineVariants, runOfflineOperator } from '../../tools/harness/operators.js'
import { assertGoldenDeclared, predict } from '../../tools/harness/predict.js'
import { runGolden, runSteps } from '../../tools/harness/runner.js'
import { toView } from '../../tools/harness/scenario.js'
import { ADVISOR_STEP, INSTANCE_ID } from '../example-flow.js'
import { edits, finalValues, golden, incomplete, STEP } from './scenario.js'

// Issue #44: Sam's typing survives network loss and refreshes (S07, RT-1,
// RT-3, RT-4, RT-5). The golden path is the start, three draft edits and the
// submit; the Offline operator does the steps of Sam without a connection,
// refreshes from the encrypted local store, reconnects and resends every
// saved operation twice. The server applies each one once (I1), every saved
// edit syncs (I15), nothing shows as confirmed before the server confirmed
// it (I16), and a sign-out destroys the local copy while the server copy
// stays (I11). A submit the server refuses when it arrives names the reason,
// and the draft stays complete (FM-4).
//
// Modes (STORIES.md, S07): the cli cell is skipped. The engine path is a
// transport simulation, and the CLI has no transport to interrupt, so the
// golden path runs in api and dry mode and the side-effect intents of the
// two must be equal (I7); it does not run through the harness CLI.

test('#44 the S07 golden path runs in api and dry mode: the edits reach the server once and the submit routes the draft (S07)', {
  timeout: 60_000,
}, async () => {
  await runGolden(golden)
  const api = await runSteps(golden, { mode: 'api' })
  const dry = await runSteps(golden, { mode: 'dry' })
  expect(dry.intents, 'dry mode and api mode differ in side effects (I7)').toEqual(api.intents)

  // Each edit is one idempotent operation on the log (I1, D1), the draft
  // holds the merged values, and the submit routed them to the advisor.
  const log = api.state.log
  expect(log.slice(STEP.firstEdit, STEP.lastEdit + 1).map((event) => event.type)).toEqual(
    edits.map(() => DRAFT_EDITED)
  )
  expect(log.slice(STEP.firstEdit, STEP.lastEdit + 1).map((event) => event.payload.values)).toEqual(
    edits
  )
  const instance = instanceOf(log, INSTANCE_ID)
  expect(instance?.values).toEqual(finalValues)
  expect(instance?.submitted).toBe(true)
  expect(instance?.currentStep).toBe(ADVISOR_STEP)
  expect(log[STEP.submit].type).toBe(INSTANCE_SUBMITTED)
})

test('#44 the Offline operator does the S07 steps without a connection, refreshes, and reconnects (S07)', {
  timeout: 60_000,
}, async () => {
  // One variant per step, in step order (I6): the connection drops before
  // that step, and every later step is done offline.
  const generated = offlineVariants(golden)
  expect(generated.map((variant) => variant.id)).toEqual(
    golden.steps.map((_, index) => `offline:from-step${index + 1}`)
  )
  // The runner checks every variant: the resent operations apply once (I1),
  // the refresh keeps every saved edit (RT-4, I15), no update shows as
  // confirmed before the server confirmed it (I16), the end state is the
  // golden end state, and the sign-out destroys the local copy (I11).
  const variants = await runOfflineOperator(golden)
  expect(variants).toHaveLength(golden.steps.length)
})

test('#44 a submit the server refuses when it arrives names the reason, and the draft stays complete (S07)', {
  timeout: 60_000,
}, async () => {
  // Sam never typed the summary, which the request form requires. Every edit
  // lands (I1), and the submit is refused with the field named (FM-4): the
  // engine predicts the refusal, and the server reproduces it.
  const outcomes = predict(incomplete).outcomes
  const refusal = outcomes[STEP.submit]
  expect('error' in refusal).toBe(true)
  if (!('error' in refusal)) throw new Error('the submit was not refused')
  expect(refusal.status).toBe(409)
  expect(refusal.error).toContain('summary')
  expect(outcomes.slice(0, STEP.submit).every((outcome) => 'operation' in outcome)).toBe(true)

  // The golden path of the variant declares its edits exactly (ADR 0010),
  // and the api run reaches the predicted end state: the draft with every
  // edit, and no submission.
  expect(() => assertGoldenDeclared(incomplete)).toThrow(/summary/)
  const { state } = await runSteps(incomplete, { mode: 'api' })
  expect(isDeepStrictEqual(toView(state), toView(predict(incomplete).state))).toBe(true)
  const draft = instanceOf(state.log, INSTANCE_ID)
  expect(draft?.submitted).toBe(false)
  expect(draft?.values).toEqual({ overload_credits: 3, advisor: 'user:okafor' })
  expect(state.log).toHaveLength(STEP.submit)
})
