import { expect, test } from 'vitest'
import { type ActionResult, claim, complete } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Instance } from '../../engine/instance.js'
import { createOperation, type OperationDeps } from '../../engine/operation.js'
import { resolveAssignees } from '../../engine/routing.js'
import { type SendBackResult, STEP_SENT_BACK, sendBack } from '../../engine/sendBack.js'
import { type StatusContext, status, visibleTo } from '../../engine/status.js'
import { startInstance } from '../../engine/submission.js'
import { isStepSkipped, STEP_SKIPPED } from '../../engine/workflow.js'
import {
  ADVISOR_STEP,
  ANA,
  anaGrants,
  CHAIR_STEP,
  chairSkipWhen,
  data,
  definition,
  flow,
  LEE,
  leeGrants,
  OKAFOR,
  okaforGrants,
  PRIYA,
  priyaGrants,
  REGISTRAR_MEMBERS,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  registrarNote,
  resolve,
  SLUG,
  STARTER,
  samGrants,
  starterGrants,
} from './scenario.js'

/** The comment that Ana records when she sends the registrar task back (WF-3, S11). */
const SEND_BACK_COMMENT = 'The advisor signature is missing'

/** The time of every event (I6): the clock is injected and the path reads no random source. */
const NOW = 1_700_000_000_000

/** The injected sources of the path (I6): the clock is a fixed time and the IDs are `op-N`. */
function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => NOW,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

/** Apply the operation that an accepted action returned (I14); the test checks acceptance first. */
function applyAction(result: ActionResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the action was refused: ${result.reason}`)
  return apply(result.operation, state)
}

/** Apply the operation that an accepted send back returned (S11, I14). */
function applySendBack(result: SendBackResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the send back was refused: ${result.reason}`)
  return apply(result.operation, state)
}

// Issue #51: Sam reads the status of his own course-overload request. The
// status line is step N of M, the current step and its holder, and the state
// tells "waiting to be opened" from "opened, in progress" (VT-1, VT-2). The
// chair step that a condition skipped shows its reason (S05). Sam reads the
// status but not the notes of the people who act on another step, and not the
// values that a scope guards (VT-3, VT-4, I8). The path is deterministic (I6).

test('#51 the status line shows the step, the holder and the wait state, and I8 hides notes and fields (S14)', () => {
  // One shared source, so every recorded operation gets a distinct ID (I1).
  const sources = deps()

  // (a) S05, WF-1: for two overload credits the chair step is skipped, so the
  // start routes past it to the request step (S06, I10).
  expect(isStepSkipped(definition.steps[0], data)).toBe(true)
  const started = startInstance(flow, data, STARTER, sources, resolve, starterGrants)
  let state = apply(started.operation, emptyState)
  expect(started.instance.currentStep).toBe(REQUEST_STEP)

  // S05, I14: the run records the skip on the log, attributed to the person
  // who advanced the flow. The status reads it from there (I4).
  const skip = createOperation(
    STEP_SKIPPED,
    { step: CHAIR_STEP, condition: chairSkipWhen },
    sources,
    STARTER
  )
  state = apply(skip, state)

  // (b) VT-1, VT-2, I6: the status line is step 2 of 4, on the request step,
  // with no holder, and it says "waiting to be opened". The skipped chair step
  // carries the condition that skipped it (S05). The same inputs give the same
  // status (I6).
  const waiting = status(started.instance, definition, state.log)
  expect(waiting.step).toBe(2)
  expect(waiting.totalSteps).toBe(4)
  expect(waiting.currentStep).toBe(REQUEST_STEP)
  expect(waiting.holder).toBeUndefined()
  expect(waiting.state).toBe('waiting')
  expect(waiting.skipped).toEqual([{ step: CHAIR_STEP, condition: chairSkipWhen }])
  expect(status(started.instance, definition, state.log)).toEqual(waiting)

  // Sam submits his own request (S09, WF-1); the instance advances to the
  // advisor step, whose field target resolves to Dr. Okafor (S06, I13).
  const atRequest: Instance = { ...started.instance, version: state.log.length }
  const claimedRequest = claim(atRequest, STARTER, atRequest.version ?? 0, sources)
  expect(claimedRequest.accepted).toBe(true)
  state = applyAction(claimedRequest, state)
  const submitted = complete(
    claimedRequest.instance,
    STARTER,
    'submit',
    claimedRequest.instance.version ?? 0,
    { flow: SLUG, definition, grants: samGrants },
    sources
  )
  expect(submitted.accepted).toBe(true)
  state = applyAction(submitted, state)
  expect(submitted.instance.currentStep).toBe(ADVISOR_STEP)

  const advisorAssignees = resolveAssignees(definition.steps[2], resolve)
  expect(advisorAssignees).toEqual([
    { step: ADVISOR_STEP, target: { field: 'advisor' }, members: [OKAFOR] },
  ])
  const atAdvisor: Instance = {
    ...submitted.instance,
    assignees: [...submitted.instance.assignees, ...advisorAssignees],
    version: state.log.length,
  }
  const claimedAdvisor = claim(atAdvisor, OKAFOR, atAdvisor.version ?? 0, sources)
  expect(claimedAdvisor.accepted).toBe(true)
  state = applyAction(claimedAdvisor, state)
  const approved = complete(
    claimedAdvisor.instance,
    OKAFOR,
    'approve',
    claimedAdvisor.instance.version ?? 0,
    { flow: SLUG, definition, grants: okaforGrants },
    sources
  )
  expect(approved.accepted).toBe(true)
  state = applyAction(approved, state)
  expect(approved.instance.currentStep).toBe(REGISTRAR_STEP)

  // (c) VT-2, S14: the registrar task waits, then Ana claims it, and the
  // status tells "waiting to be opened" from "opened, in progress".
  const registrarAssignees = resolveAssignees(definition.steps[3], resolve)
  expect(registrarAssignees).toEqual([
    { step: REGISTRAR_STEP, target: { team: REGISTRAR_TEAM }, members: REGISTRAR_MEMBERS },
  ])
  const atRegistrar: Instance = {
    ...approved.instance,
    assignees: [...approved.instance.assignees, ...registrarAssignees],
    version: state.log.length,
  }
  const unopened = status(atRegistrar, definition, state.log)
  expect(unopened.step).toBe(4)
  expect(unopened.currentStep).toBe(REGISTRAR_STEP)
  expect(unopened.holder).toBeUndefined()
  expect(unopened.state).toBe('waiting')

  const claimedRegistrar = claim(atRegistrar, ANA, atRegistrar.version ?? 0, sources)
  expect(claimedRegistrar.accepted).toBe(true)
  state = applyAction(claimedRegistrar, state)
  const held = claimedRegistrar.instance
  const inProgress = status(held, definition, state.log)
  expect(inProgress.step).toBe(4)
  expect(inProgress.totalSteps).toBe(4)
  expect(inProgress.currentStep).toBe(REGISTRAR_STEP)
  expect(inProgress.holder).toBe(ANA)
  expect(inProgress.state).toBe('in-progress')
  expect(inProgress.skipped).toEqual([{ step: CHAIR_STEP, condition: chairSkipWhen }])

  // (d) VT-3, I8: Ana sends the registrar task back to the advisor with a note
  // (WF-3, S11). The note sits on the advisor step. Sam, who acts on the
  // request step only, reads the status but not the note; Dr. Okafor, who acts
  // on the advisor step, reads it.
  const base: StatusContext = { flow: SLUG, definition, log: state.log, grants: anaGrants }
  const sent = sendBack(
    held,
    ANA,
    ADVISOR_STEP,
    SEND_BACK_COMMENT,
    held.version ?? 0,
    { flow: SLUG, grants: anaGrants },
    sources
  )
  expect(sent.accepted).toBe(true)
  const sentState = applySendBack(sent, state)
  expect(sentState.log.filter((event) => event.type === STEP_SENT_BACK)).toHaveLength(1)

  const sentContext: StatusContext = { ...base, log: sentState.log }

  const samView = visibleTo(
    STARTER,
    sent.instance,
    { ...base, log: sentState.log, grants: samGrants },
    [registrarNote]
  )
  expect(samView.readable).toBe(true) // AC-5: a starter always reads their own instance
  expect(samView.status?.step).toBe(3)
  expect(samView.status?.currentStep).toBe(ADVISOR_STEP)
  expect(samView.status?.state).toBe('waiting')
  expect(samView.notes).toEqual([]) // I8: not the note of another person
  expect(samView.values).toEqual([]) // VT-4: the guarded value is hidden

  const okaforView = visibleTo(OKAFOR, sent.instance, { ...sentContext, grants: okaforGrants }, [
    registrarNote,
  ])
  expect(okaforView.readable).toBe(true)
  expect(okaforView.notes).toEqual([{ step: ADVISOR_STEP, actor: ANA, comment: SEND_BACK_COMMENT }])

  // Lee acts on the registrar step, not on the advisor step, and did not write
  // the note, so he reads the instance and not the note (I8, AC-4).
  const leeView = visibleTo(LEE, sent.instance, { ...sentContext, grants: leeGrants }, [
    registrarNote,
  ])
  expect(leeView.readable).toBe(true)
  expect(leeView.notes).toEqual([])

  // An actor that may not read the instance reads no status, no note and no
  // value (I8).
  const strangerView = visibleTo('user:stranger', sent.instance, { ...sentContext, grants: [] }, [
    registrarNote,
  ])
  expect(strangerView.readable).toBe(false)
  expect(strangerView.status).toBeUndefined()
  expect(strangerView.notes).toEqual([])
  expect(strangerView.values).toEqual([])

  // (e) VT-4, I8: a principal that holds the guarded scope reads the value, and
  // the starter does not. The read is authorized exactly as a write (AC-1).
  const priyaView = visibleTo(PRIYA, sent.instance, { ...sentContext, grants: priyaGrants }, [
    registrarNote,
  ])
  expect(priyaView.values).toEqual([registrarNote])

  // (f) VT-2: an instance that completed its last step reads done, and a
  // withdrawn or cancelled instance reads its close (WF-4, WF-5).
  const closed: Instance = { ...held, currentStep: undefined, holder: undefined }
  expect(status({ ...closed, done: true }, definition, state.log).state).toBe('done')
  expect(status({ ...closed, withdrawal: 'withdrawn' }, definition, state.log).state).toBe(
    'withdrawn'
  )
  expect(status({ ...closed, withdrawal: 'cancelled' }, definition, state.log).state).toBe(
    'cancelled'
  )

  // (g) I6: the same inputs give the same view.
  const viewOnce = (): unknown =>
    visibleTo(STARTER, sent.instance, { ...sentContext, grants: samGrants }, [registrarNote])
  expect(viewOnce()).toEqual(viewOnce())
})
