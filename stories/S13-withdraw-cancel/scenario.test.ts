import { expect, test } from 'vitest'
import { instanceOf } from '../../engine/instances.js'
import { outboxOf } from '../../engine/outbox.js'
import { EMAIL_CONNECTOR } from '../../engine/submission.js'
import {
  INSTANCE_CANCELLED,
  INSTANCE_UNDONE,
  INSTANCE_WITHDRAWN,
  WITHDRAW_CANCEL_NOTIFICATION,
} from '../../engine/withdraw.js'
import { predict } from '../../tools/harness/predict.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import type { Scenario } from '../../tools/harness/scenario.js'
import { ANA, INSTANCE_ID, PRIYA, REGISTRAR_STEP, SAM } from '../example-flow.js'
import {
  CANCEL_REASON,
  clock,
  golden,
  HOUR,
  instanceAfter,
  STEP,
  UNDO_PERIOD,
  WITHDRAW_REASON,
} from './scenario.js'

// Issue #50: Sam withdraws his own instance (WF-4, AC-5), and the engine
// closes the open task and notifies Ana, its holder, in the same commit
// (SE-5, I2). Priya cancels with `instance.cancel` (AC-5, AC-1), and a
// principal without the scope is refused with 403. An undo within the flow's
// undo period restores the previous step and holder as a compensating event
// (WF-5, I4); a late undo is refused. The path is deterministic (I6).

/** The golden path with one step done by another person (the Actor operator's variation). */
function doneBy(index: number, actor: string): Scenario {
  return {
    ...golden,
    steps: golden.steps.map((step, i) => (i === index ? { ...step, actor } : step)),
  }
}

test('#50 the S13 golden path runs in api, cli and dry mode: the close notifies the holder and the undo restores the step (S13)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // (a) WF-4, SE-5, I2: the withdrawal closed the registrar task, recorded
  // the previous step and holder for the undo, and notified Ana in the same
  // operation (I2).
  const withdrawn = instanceAfter(golden.steps.slice(0, STEP.withdraw + 1))
  expect(withdrawn.currentStep).toBeUndefined()
  expect(withdrawn.holder).toBeUndefined()
  expect(withdrawn.withdrawal).toBe('withdrawn')
  expect(withdrawn.previousStep).toBe(REGISTRAR_STEP)
  expect(withdrawn.previousHolder).toBe(ANA)
  expect(withdrawn.closedBy).toBe(SAM)
  expect(withdrawn.closedAt).toBe(clock(STEP.withdraw))
  const notifications = outboxOf(state.log).filter(
    (entry) => entry.operation === WITHDRAW_CANCEL_NOTIFICATION
  )
  expect(notifications).toEqual([
    {
      operation: WITHDRAW_CANCEL_NOTIFICATION,
      target: EMAIL_CONNECTOR,
      payload: { to: ANA, step: REGISTRAR_STEP, actor: SAM, reason: WITHDRAW_REASON },
    },
    {
      operation: WITHDRAW_CANCEL_NOTIFICATION,
      target: EMAIL_CONNECTOR,
      payload: { to: ANA, step: REGISTRAR_STEP, actor: PRIYA, reason: CANCEL_REASON },
    },
  ])

  // (b) WF-5, I4: each undo is a compensating event that restores the
  // registrar step and Ana as its holder; the withdrawal and the
  // cancellation stay in the log.
  const restored = instanceAfter(golden.steps.slice(0, STEP.undoWithdraw + 1))
  expect(restored.currentStep).toBe(REGISTRAR_STEP)
  expect(restored.holder).toBe(ANA)
  expect(restored.withdrawal).toBeUndefined()
  const end = instanceOf(state.log, INSTANCE_ID)
  expect(end?.currentStep).toBe(REGISTRAR_STEP)
  expect(end?.holder).toBe(ANA)
  expect(end?.withdrawal).toBeUndefined()
  expect(state.log.filter((event) => event.type === INSTANCE_WITHDRAWN)).toHaveLength(1)
  expect(state.log.filter((event) => event.type === INSTANCE_CANCELLED)).toHaveLength(1)
  expect(state.log.filter((event) => event.type === INSTANCE_UNDONE)).toHaveLength(2)
  expect(state.log.find((event) => event.type === INSTANCE_UNDONE)?.payload).toEqual({
    instanceId: INSTANCE_ID,
    undoOf: 'withdrawn',
    step: REGISTRAR_STEP,
    holder: ANA,
  })
}, 60_000)

test('#50 AC-5 the engine refuses a withdrawal or a cancellation by someone else with 403 (S13)', () => {
  // Ana, the holder, tries to withdraw Sam's instance: only the starter may.
  const anaWithdraws = predict(doneBy(STEP.withdraw, ANA)).outcomes[STEP.withdraw]
  expect('error' in anaWithdraws && anaWithdraws.status).toBe(403)
  expect('error' in anaWithdraws && anaWithdraws.error).toContain('starter')

  // Sam tries to cancel: he holds no instance.cancel on the flow (AC-1).
  const samCancels = predict(doneBy(STEP.cancel, SAM)).outcomes[STEP.cancel]
  expect('error' in samCancels && samCancels.status).toBe(403)
  expect('error' in samCancels && samCancels.error).toContain('instance.cancel')

  // Ana did not close the instance, so she may not undo the close (WF-5).
  const anaUndoes = predict(doneBy(STEP.undoWithdraw, ANA)).outcomes[STEP.undoWithdraw]
  expect('error' in anaUndoes && anaUndoes.status).toBe(409)
  expect('error' in anaUndoes && anaUndoes.error).toContain('did not withdraw')
})

test('#50 WF-5 an undo past the undo period of the flow is refused (S13)', () => {
  // The same path with the undo of the withdrawal twenty-five hours after
  // the close: the engine refuses it, and the instance stays withdrawn, so
  // the later cancel is refused too.
  const late: Scenario = {
    ...golden,
    clock: (index) => clock(index) + (index >= STEP.undoWithdraw ? UNDO_PERIOD + HOUR : 0),
  }
  const { outcomes, state } = predict(late)
  const refused = outcomes[STEP.undoWithdraw]
  expect('error' in refused && refused.status).toBe(409)
  expect('error' in refused && refused.error).toContain('period')
  expect(instanceOf(state.log, INSTANCE_ID)?.withdrawal).toBe('withdrawn')
  expect(outcomes[STEP.cancel]).toHaveProperty('error')
})
