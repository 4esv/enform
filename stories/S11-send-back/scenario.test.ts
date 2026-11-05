import { expect, test } from 'vitest'
import { complete } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import type { Log } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { SENT_BACK_NOTIFICATION, STEP_SENT_BACK, sendBack } from '../../engine/sendBack.js'
import { INSTANCE_SUBMITTED } from '../../engine/submission.js'
import { predict } from '../../tools/harness/predict.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ADVISOR_STEP,
  definitionV1,
  directory,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  OKAFOR,
  REGISTRAR_STEP,
  REQUEST_STEP,
  SAM,
  SLUG,
  stateAfter,
} from '../example-flow.js'
import { COMMENT, CORRECTION, golden, JORDAN_COMMENT, STEP, values } from './scenario.js'

// Issue #48: Dr. Okafor sends Sam's request back with a note, so Sam corrects
// it and does not start again (WF-2, WF-3). A send back without a comment is
// refused (WF-3). Sam submits again and the instance goes to the advisor step
// again; the timeline shows both revisions (WF-3). Jordan can send back at the
// registrar step and cannot approve (S02, AC-4). The path is deterministic
// (I6).

/**
 * The revisions of one step on the timeline (WF-3, S11): revision 1 is the
 * event that first routed the instance to the step, and each send back to the
 * step records the next revision in its payload.
 */
function revisionsOnTimeline(log: Log, step: string): number[] {
  const revisions: number[] = []
  for (const event of log) {
    if (event.payload.currentStep === step) revisions.push(1)
    const revision = event.payload.revision
    if (event.payload.to === step && typeof revision === 'number') revisions.push(revision)
  }
  return revisions
}

/** The injected sources of a check (I6). */
const deps = (index: number) => ({ clock: () => index + 1, ids: () => `check-${index}` })

test('#48 the S11 golden path runs in api, cli and dry mode: the send back, the resubmission and both revisions (S11)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // The send back returned the request to the request form as revision 2,
  // with the note to Sam in the same commit (WF-3, I2, SE-2), and Sam's
  // resubmission routed the instance to the advisor step again.
  const sentBack = state.log.filter((event) => event.type === STEP_SENT_BACK)
  expect(sentBack).toHaveLength(2)
  expect(sentBack[0].actor).toBe(OKAFOR)
  expect(sentBack[0].payload).toMatchObject({
    instanceId: INSTANCE_ID,
    from: ADVISOR_STEP,
    to: REQUEST_STEP,
    comment: COMMENT,
    revision: 2,
  })
  expect(outboxOf(state.log)).toContainEqual({
    operation: SENT_BACK_NOTIFICATION,
    target: 'connector-smtp',
    payload: { to: SAM, step: REQUEST_STEP, from: ADVISOR_STEP, actor: OKAFOR, comment: COMMENT },
  })
  const submits = state.log.filter((event) => event.type === INSTANCE_SUBMITTED)
  expect(submits).toHaveLength(2)
  expect(submits[1].payload.currentStep).toBe(ADVISOR_STEP)
  expect(revisionsOnTimeline(state.log, REQUEST_STEP)).toEqual([1, 2])

  // Jordan sent the registrar task back to the advisor step (AC-4): the
  // instance waits there as revision 2 of that step, and the corrected
  // summary is the one the instance holds.
  expect(sentBack[1].actor).toBe(JORDAN)
  expect(sentBack[1].payload).toMatchObject({
    from: REGISTRAR_STEP,
    to: ADVISOR_STEP,
    comment: JORDAN_COMMENT,
    revision: 2,
  })
  const instance = instanceOf(state.log, INSTANCE_ID)
  expect(instance?.currentStep).toBe(ADVISOR_STEP)
  expect(instance?.holder).toBeUndefined()
  expect(instance?.values).toEqual({ ...values, ...CORRECTION })
  expect(revisionsOnTimeline(state.log, ADVISOR_STEP)).toEqual([1, 1, 2])
}, 60_000)

test('#48 a send back needs a comment, the holder, and the send back scope (S11)', () => {
  // The view after Dr. Okafor's claim: he holds the advisor task.
  const held = instanceAfter(golden.steps.slice(0, STEP.okaforSendBack))
  expect(held.holder).toBe(OKAFOR)
  const version = held.version ?? 0
  const context = {
    flow: SLUG,
    definition: definitionV1,
    grants: grantsOfPerson(OKAFOR),
    resolve: directory(values),
  }

  // (a) WF-3: a send back without a comment is refused; so is a blank one.
  const noComment = sendBack(
    held,
    OKAFOR,
    REQUEST_STEP,
    '',
    version,
    context,
    deps(STEP.okaforSendBack)
  )
  expect(noComment.accepted).toBe(false)
  expect(noComment.refusal).toBe('comment')
  const blank = sendBack(
    held,
    OKAFOR,
    REQUEST_STEP,
    '   ',
    version,
    context,
    deps(STEP.okaforSendBack)
  )
  expect(blank.accepted).toBe(false)
  // The server refuses the same intent as a bad request, and appends nothing.
  const withoutComment = {
    ...golden,
    steps: golden.steps.map((step, index) =>
      index === STEP.okaforSendBack ? { ...step, intent: { ...step.intent, comment: '' } } : step
    ),
  }
  const outcome = predict(withoutComment).outcomes[STEP.okaforSendBack]
  expect('error' in outcome && outcome.status).toBe(400)
  expect('error' in outcome && outcome.error).toContain('comment')

  // (b) WF-3: a principal that is not the holder may not send the step back,
  // and a holder without step.outcome:send_back may not either (AC-4).
  const outsider = sendBack(
    held,
    SAM,
    REQUEST_STEP,
    COMMENT,
    version,
    { ...context, grants: grantsOfPerson(SAM) },
    deps(STEP.okaforSendBack)
  )
  expect(outsider.accepted).toBe(false)
  expect(outsider.refusal).toBe('holder')
  const noScope = sendBack(
    held,
    OKAFOR,
    REQUEST_STEP,
    COMMENT,
    version,
    { ...context, grants: [] },
    deps(STEP.okaforSendBack)
  )
  expect(noScope.accepted).toBe(false)
  expect(noScope.refusal).toBe('outcome')

  // (c) I5: a send back from a stale view is refused at once.
  const stale = sendBack(
    held,
    OKAFOR,
    REQUEST_STEP,
    COMMENT,
    version - 1,
    context,
    deps(STEP.okaforSendBack)
  )
  expect(stale.accepted).toBe(false)
  expect(stale.refusal).toBe('stale')

  // (d) ADR 0014: the send back to the request form makes the instance a
  // draft again, held by nobody, and the submit path takes it from there.
  const sent = sendBack(
    held,
    OKAFOR,
    REQUEST_STEP,
    COMMENT,
    version,
    context,
    deps(STEP.okaforSendBack)
  )
  expect(sent.accepted).toBe(true)
  expect(sent.instance.currentStep).toBe(REQUEST_STEP)
  expect(sent.instance.submitted).toBe(false)
  expect(sent.instance.holder).toBeUndefined()
  expect(sent.instance.revisions).toEqual({ [REQUEST_STEP]: 2 })
})

test('#48 Jordan can send back at the registrar step and cannot approve (S11, S02)', () => {
  // The view after Jordan's claim of the registrar task.
  const held = instanceAfter(golden.steps.slice(0, STEP.jordanSendBack))
  expect(held.holder).toBe(JORDAN)
  const version = held.version ?? 0
  const context = {
    flow: SLUG,
    definition: definitionV1,
    grants: grantsOfPerson(JORDAN),
    resolve: directory({ ...values, ...CORRECTION }),
  }

  // Jordan holds step.outcome:send_back only (AC-4): approve is refused.
  const approve = complete(held, JORDAN, 'approve', {}, version, context, deps(STEP.jordanSendBack))
  expect(approve.accepted).toBe(false)
  expect(approve.reason).toContain('step.outcome:approve')
  // The server answers 403 for it (S02).
  const approving = {
    ...golden,
    steps: golden.steps.map((step, index) =>
      index === STEP.jordanSendBack
        ? {
            ...step,
            type: 'step.completed@1',
            intent: { instanceId: INSTANCE_ID, version, outcome: 'approve', values: {} },
          }
        : step
    ),
  }
  const outcome = predict(approving).outcomes[STEP.jordanSendBack]
  expect('error' in outcome && outcome.status).toBe(403)

  // The send back is accepted, and its note goes to the advisor step's
  // assignee, Dr. Okafor (SE-2).
  const sent = sendBack(
    held,
    JORDAN,
    ADVISOR_STEP,
    JORDAN_COMMENT,
    version,
    context,
    deps(STEP.jordanSendBack)
  )
  expect(sent.accepted).toBe(true)
  expect(sent.outbox?.payload.to).toBe(OKAFOR)
  expect(
    stateAfter(golden.steps).log.filter((event) => event.type === STEP_SENT_BACK)
  ).toHaveLength(2)
})
