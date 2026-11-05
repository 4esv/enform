import { expect, test } from 'vitest'
import { STEP_COMPLETED } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import { readableLog } from '../../engine/logRead.js'
import { outboxOf } from '../../engine/outbox.js'
import { ASSIGNMENT_EMAIL, EMAIL_CONNECTOR } from '../../engine/submission.js'
import {
  ALREADY_SENT,
  alreadySentOf,
  EVENT_UNDONE,
  notifiedBy,
  UNDO_NOTIFICATION,
} from '../../engine/undo.js'
import { predict } from '../../tools/harness/predict.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import type { Scenario } from '../../tools/harness/scenario.js'
import { grantsOfPerson, INSTANCE_ID, LEE, PRIYA, REGISTRAR_STEP } from '../example-flow.js'
import { ARCHIVE_STEP, golden, REASON, STEP } from './scenario.js'

// Issue #53: Lee approved the wrong request (S16). The undo is a compensating
// event (WF-5, D6): the engine appends an `event.undone@1` event, and the
// approval stays in the log with its payload and its author (I4, I14). The
// email that already went out is not reversed: the undo marks it "Already
// sent" and notifies Priya, whom it reached, in the same commit (A2, I2).
// Once Priya recorded the decision on the archive step, the final step of the
// flow, the engine refuses every undo on the instance with that reason (S16,
// WF-5). The path is deterministic (I6).

/** The seq of the event that step `index` appended (I4): the log is one global order. */
const seqOf = (index: number): number => index + 1

test('#53 the S16 golden path runs in api, cli and dry mode: the undo is a compensating event (S16)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)
  const log = state.log

  // (a) WF-5, D6, I4: the undo records which event it covers, why and who
  // undid it; the wrong approval stays in the log, unchanged, and the right
  // one follows it.
  const undo = log[STEP.leeUndo]
  expect(undo.type).toBe(EVENT_UNDONE)
  expect(undo.actor).toBe(LEE)
  expect(undo.payload).toMatchObject({
    instanceId: INSTANCE_ID,
    eventId: seqOf(STEP.leeApprove),
    reason: REASON,
  })
  const wrong = log[STEP.leeApprove]
  expect(wrong.type).toBe(STEP_COMPLETED)
  expect(wrong.actor).toBe(LEE)
  expect(wrong.payload.step).toBe(REGISTRAR_STEP)
  expect(log.filter((event) => event.type === STEP_COMPLETED)).toHaveLength(4)

  // The projection folds the approval out: after the undo the instance was
  // back at the registrar step, held by Lee (I4), and the version kept
  // advancing (I5). At the end Priya recorded the decision and the flow is
  // done.
  const afterUndo = instanceOf(log.slice(0, STEP.leeUndo + 1), INSTANCE_ID)
  expect(afterUndo?.currentStep).toBe(REGISTRAR_STEP)
  expect(afterUndo?.holder).toBe(LEE)
  expect(afterUndo?.version).toBe(6)
  const end = instanceOf(log, INSTANCE_ID)
  expect(end?.done).toBe(true)
  expect(end?.version).toBe(9)

  // (b) S16, DX-3: `enform log --instance <id> --limit 5` for Lee: the five
  // newest events of the instance, which he reads as its assignee (I8).
  const tail = readableLog(log, LEE, {
    grants: grantsOfPerson(LEE),
    instanceId: INSTANCE_ID,
    limit: 5,
  })
  expect(tail.map((event) => event.seq)).toEqual(
    [STEP.emailSent, STEP.leeUndo, STEP.leeApproveAgain, STEP.priyaClaim, STEP.priyaRecord].map(
      seqOf
    )
  )
  expect(tail.every((event) => event.payload.instanceId === INSTANCE_ID)).toBe(true)
}, 60_000)

test('#53 A2 the undo marks the email that already went out "Already sent" and notifies the person it reached (S16)', () => {
  // The worker recorded the call for the assignment email to Priya before
  // the undo (I13), so the engine does not reverse it: it marks it and
  // notifies Priya in the same operation as the compensating event (I2).
  const { state } = predict(golden)
  const log = state.log
  const approvalSeq = seqOf(STEP.leeApprove)
  expect(alreadySentOf(log, approvalSeq)).toEqual([
    {
      operation: ASSIGNMENT_EMAIL,
      target: EMAIL_CONNECTOR,
      to: PRIYA,
      status: ALREADY_SENT,
    },
  ])
  expect(notifiedBy(log, approvalSeq)).toEqual([PRIYA])
  const undo = log[STEP.leeUndo]
  expect(outboxOf([undo])).toEqual([
    {
      operation: UNDO_NOTIFICATION,
      target: EMAIL_CONNECTOR,
      payload: { to: PRIYA, eventId: approvalSeq, actor: LEE, reason: REASON },
    },
  ])
})

test('#53 WF-5 once the flow passed its final step the engine refuses an undo with the reason (S16)', () => {
  // Priya tries to undo her own record of the decision, the final step: the
  // engine refuses it and names the step; Lee's approval is past it too.
  const priyaUndo = {
    actor: PRIYA,
    type: EVENT_UNDONE,
    payload: {},
    intent: {
      instanceId: INSTANCE_ID,
      eventId: seqOf(STEP.priyaRecord),
      reason: REASON,
      version: 9,
    },
  }
  const past: Scenario = { ...golden, steps: [...golden.steps, priyaUndo] }
  const refused = predict(past).outcomes[golden.steps.length]
  expect('error' in refused && refused.status).toBe(409)
  expect('error' in refused && refused.error).toContain('final')
  expect('error' in refused && refused.error).toContain(ARCHIVE_STEP)

  // Before the record the same undo of the right approval is the latest
  // action, so the engine accepts it: the refusal comes from the final step.
  const leeUndo = {
    actor: LEE,
    type: EVENT_UNDONE,
    payload: {},
    intent: {
      instanceId: INSTANCE_ID,
      eventId: seqOf(STEP.leeApproveAgain),
      reason: REASON,
      version: 7,
    },
  }
  const open: Scenario = { ...golden, steps: [...golden.steps.slice(0, STEP.priyaClaim), leeUndo] }
  expect(predict(open).outcomes[STEP.priyaClaim]).toHaveProperty('operation')
})
