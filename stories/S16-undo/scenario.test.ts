import { expect, test } from 'vitest'
import { type ActionResult, claim, complete, STEP_COMPLETED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { FlowStep } from '../../engine/definition.js'
import type { Instance } from '../../engine/instance.js'
import { type ActorId, createOperation, type OperationDeps } from '../../engine/operation.js'
import { createOutboxOperation, outboxOf } from '../../engine/outbox.js'
import { resolveAssignees } from '../../engine/routing.js'
import { EMAIL_CONNECTOR, startInstance } from '../../engine/submission.js'
import { CONNECTOR_CALLED } from '../../engine/timeline.js'
import {
  ALREADY_SENT,
  alreadySentOf,
  EVENT_UNDONE,
  notifiedBy,
  UNDO_NOTIFICATION,
  type UndoResult,
  undo,
} from '../../engine/undo.js'
import {
  ADVISOR_STEP,
  APPROVE,
  approvalOutbox,
  CONFIRMATION_EMAIL,
  DECISION_PDF,
  data,
  definition,
  finalPoint,
  flow,
  LEE,
  OFFICE_COPY,
  OKAFOR,
  okaforGrants,
  PRIYA,
  REGISTRAR_STEP,
  REQUEST_STEP,
  resolve,
  SLUG,
  STARTER,
  SUBMIT,
  SYSTEM,
  samGrants,
  sentCalls,
  starterGrants,
} from './scenario.js'

/** The reason that Lee gives for the undo (STORIES.md, S16). */
const REASON = 'Approved the wrong request'

/** The time of the first operation (I6): the clock is injected, one minute per operation. */
const NOW = 1_700_000_000_000

/**
 * The injected sources of the path (I6): the clock advances one minute per
 * operation and the IDs are `op-N`, so every operation gets a distinct ID and a
 * distinct time, in the order of the story.
 */
function deps(): OperationDeps {
  let time = 0
  let id = 0
  return {
    clock: () => {
      const at = NOW + time * 60_000
      time += 1
      return at
    },
    ids: () => {
      id += 1
      return `op-${id}`
    },
  }
}

/** Apply the operation that an accepted action returned (I14); the test checks acceptance first. */
function applyAction(result: ActionResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the action was refused: ${result.reason}`)
  return apply(result.operation, state)
}

/** Apply the compensating operation that an accepted undo returned (S16, I4). */
function applyUndo(result: UndoResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the undo was refused: ${result.reason}`)
  return apply(result.operation, state)
}

/**
 * Open one step of the flow (S06, S09, I13): the engine records the assignees
 * of a step when the flow starts it, so the story appends the snapshot of that
 * step's targets, and the actor then claims the task.
 */
function openStep(
  instance: Instance,
  step: FlowStep,
  actor: ActorId,
  state: State,
  sources: OperationDeps
): { readonly instance: Instance; readonly state: State } {
  const atStep: Instance = {
    ...instance,
    assignees: [...instance.assignees, ...resolveAssignees(step, resolve)],
  }
  const claimed = claim(atStep, actor, atStep.version ?? 0, sources)
  if (claimed.operation === undefined) throw new Error(`the claim was refused: ${claimed.reason}`)
  return { instance: claimed.instance, state: apply(claimed.operation, state) }
}

// Issue #53: Lee approved the wrong request (S16). The undo is a compensating
// event (WF-5, D6): the engine appends an `event.undone@1` event, and the
// approval stays in the log with its payload and its author (I4, I14). The
// confirmation email, the decision PDF and the copy to the coordinator already
// went out, so the undo does not reverse them: it marks each "Already sent" and
// notifies the people that they reached in the same commit (A2, I2). Once the
// flow decided a later step the advisor decision sits past the point that the
// flow marks final, and the engine refuses the undo with that reason (S16,
// WF-5). The path is deterministic (I6).

test('#53 an undo appends a compensating event and marks the side effects that already occurred (S16)', () => {
  // One shared source, so every recorded operation gets a distinct ID (I1).
  const sources = deps()

  // Sam starts the request: the start routes the draft to the request step,
  // whose starter target resolves to him (S06, WF-1, I13).
  const started = startInstance(flow, data, STARTER, sources, resolve, starterGrants)
  expect(started.instance.currentStep).toBe(REQUEST_STEP)
  let state = apply(started.operation, emptyState)

  // Sam claims the request step and completes it with submit, so the instance
  // advances to the advisor step (S09, WF-1).
  const atRequest: Instance = { ...started.instance, version: state.log.length }
  const claimedRequest = claim(atRequest, STARTER, atRequest.version ?? 0, sources)
  expect(claimedRequest.accepted).toBe(true)
  state = applyAction(claimedRequest, state)
  const submitted = complete(
    claimedRequest.instance,
    STARTER,
    SUBMIT,
    claimedRequest.instance.version ?? 0,
    { flow: SLUG, definition, grants: samGrants },
    sources
  )
  expect(submitted.accepted).toBe(true)
  state = applyAction(submitted, state)
  expect(submitted.instance.currentStep).toBe(ADVISOR_STEP)

  // Dr. Okafor claims the advisor task and approves it, so the instance
  // advances to the registrar step (S08, S09, AC-4).
  const atAdvisor = openStep(submitted.instance, definition.steps[1], OKAFOR, state, sources)
  state = atAdvisor.state
  const advisorDecision = complete(
    atAdvisor.instance,
    OKAFOR,
    APPROVE,
    atAdvisor.instance.version ?? 0,
    { flow: SLUG, definition, grants: okaforGrants },
    sources
  )
  expect(advisorDecision.accepted).toBe(true)
  state = applyAction(advisorDecision, state)
  expect(advisorDecision.instance.currentStep).toBe(REGISTRAR_STEP)
  const advisorSeq = state.log.length

  // Lee claims the registrar task and approves the wrong request (S16). The
  // flow's automation attaches the confirmation email, the decision PDF and
  // the copy to the coordinator to the approval, so one apply commits the
  // decision and its side effects together (I2, SE-1).
  const atRegistrar = openStep(advisorDecision.instance, definition.steps[2], LEE, state, sources)
  state = atRegistrar.state
  const approval = createOutboxOperation(
    STEP_COMPLETED,
    { step: REGISTRAR_STEP, outcome: APPROVE },
    approvalOutbox,
    sources,
    LEE
  )
  state = apply(approval, state)
  const approvalSeq = state.log.length

  // The worker already ran the three side effects, so it records each call as
  // an event of its own (SE-1, I13): the log states what already occurred.
  for (const call of sentCalls) {
    state = apply(createOperation(CONNECTOR_CALLED, { ...call }, sources, SYSTEM), state)
  }
  const log = state.log

  // (a) WF-5, D6, I4: the undo is a compensating event. The engine appends an
  // event that records which event it covers, why and who undid it, and the
  // approval stays in the log, at its own position and unchanged.
  const undone = undo(approvalSeq, REASON, log, sources, {
    actor: LEE,
    finalPoint,
    calls: sentCalls,
  })
  expect(undone.accepted).toBe(true)
  expect(undone.operation?.type).toBe(EVENT_UNDONE)
  expect(undone.operation?.actor).toBe(LEE)
  expect(undone.operation?.payload.eventId).toBe(approvalSeq)
  expect(undone.operation?.payload.reason).toBe(REASON)
  const after = applyUndo(undone, state)
  expect(after.log).toHaveLength(log.length + 1)
  expect(after.log.slice(0, log.length)).toEqual(log)
  // The approval is the same object, so the undo rewrote or deleted nothing
  // (I4), and the submit and both decisions of the flow stay in the log.
  expect(after.log[approvalSeq - 1]).toBe(log[approvalSeq - 1])
  expect(after.log.filter((event) => event.type === STEP_COMPLETED)).toHaveLength(3)

  // (b) A2, S16: the three side effects already occurred, so the undo does not
  // reverse them. It marks each "Already sent", and it notifies the people that
  // they reached, in the same operation as the compensating event (I2).
  expect(undone.alreadySent).toEqual([
    { operation: CONFIRMATION_EMAIL, target: EMAIL_CONNECTOR, to: STARTER, status: ALREADY_SENT },
    { operation: DECISION_PDF, target: EMAIL_CONNECTOR, to: STARTER, status: ALREADY_SENT },
    { operation: OFFICE_COPY, target: EMAIL_CONNECTOR, to: PRIYA, status: ALREADY_SENT },
  ])
  // Sam received two of the three side effects, so the undo notifies him once.
  expect(undone.notified).toEqual([STARTER, PRIYA])
  expect(undone.outbox).toEqual([
    {
      operation: UNDO_NOTIFICATION,
      target: EMAIL_CONNECTOR,
      payload: { to: STARTER, eventId: approvalSeq, actor: LEE, reason: REASON },
    },
    {
      operation: UNDO_NOTIFICATION,
      target: EMAIL_CONNECTOR,
      payload: { to: PRIYA, eventId: approvalSeq, actor: LEE, reason: REASON },
    },
  ])
  expect(undone.operation?.payload).toEqual({
    eventId: approvalSeq,
    reason: REASON,
    notified: undone.notified,
    alreadySent: undone.alreadySent,
    outbox: undone.outbox,
  })
  // I2: the notifications ride in the one event that the undo appended, so the
  // outbox is the projection of that event.
  expect(outboxOf(after.log).slice(-2)).toEqual(undone.outbox)

  // The status and the timeline read the marker from the log alone (I4): the
  // side effects that already occurred, and the people that the undo notified.
  expect(alreadySentOf(after.log, approvalSeq)).toEqual(undone.alreadySent)
  expect(notifiedBy(after.log, approvalSeq)).toEqual([STARTER, PRIYA])
  // An event that no undo covers marks nothing and notified nobody.
  expect(alreadySentOf(after.log, advisorSeq)).toEqual([])
  expect(notifiedBy(after.log, advisorSeq)).toEqual([])

  // (c) S16, WF-5: the flow decided the registrar step after the advisor
  // decision, so the advisor decision sits past the point that the flow marks
  // final. The engine refuses the undo and gives that reason.
  const pastFinal = undo(advisorSeq, REASON, after.log, sources, {
    actor: OKAFOR,
    finalPoint,
    calls: sentCalls,
  })
  expect(pastFinal.accepted).toBe(false)
  expect(pastFinal.operation).toBeUndefined()
  expect(pastFinal.outbox).toBeUndefined()
  expect(pastFinal.alreadySent).toBeUndefined()
  expect(pastFinal.notified).toBeUndefined()
  expect(pastFinal.reason).toContain('final')
  expect(pastFinal.reason).toContain(ADVISOR_STEP)
  // The refusal comes from the final point that the flow injects: without it
  // the engine accepts the same undo, because the approval is a manual action
  // (WF-5).
  const openPoint = undo(advisorSeq, REASON, after.log, sources, {
    actor: OKAFOR,
    calls: sentCalls,
  })
  expect(openPoint.accepted).toBe(true)

  // The log holds no such event, so there is nothing to undo (I4).
  const missing = undo(after.log.length + 1, REASON, after.log, sources, { actor: LEE })
  expect(missing.accepted).toBe(false)
  expect(missing.operation).toBeUndefined()
  expect(missing.reason).toContain('has no event')

  // (d) I6: the same inputs give the same result.
  const runOnce = (): UndoResult =>
    undo(approvalSeq, REASON, log, deps(), { actor: LEE, finalPoint, calls: sentCalls })
  expect(runOnce()).toEqual(runOnce())
})
