import { expect, test } from 'vitest'
import { type ActionResult, claim, complete } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Instance } from '../../engine/instance.js'
import type { Log, OperationDeps } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { resolveAssignees } from '../../engine/routing.js'
import {
  SENT_BACK_NOTIFICATION,
  type SendBackContext,
  type SendBackResult,
  STEP_SENT_BACK,
  sendBack,
} from '../../engine/sendBack.js'
import { EMAIL_CONNECTOR, startInstance } from '../../engine/submission.js'
import {
  data,
  definition,
  flow,
  JORDAN,
  jordanGrants,
  REGISTRAR_MEMBERS,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  resolve,
  SLUG,
  STARTER,
  samGrants,
  starterGrants,
} from './scenario.js'

/** The note that Jordan attaches to the send back (WF-3, SE-2). */
const COMMENT = 'Attach your degree audit'

/** The injected sources of the path (I6): the clock is a fixed time and the IDs are `op-N`. */
function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
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

/** Apply the operation that an accepted send back returned (I14). */
function applySendBack(result: SendBackResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the action was refused: ${result.reason}`)
  return apply(result.operation, state)
}

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

// Issue #48: Sam's request is at the registrar step, held by Jordan, a
// reviewer who may send back and may not approve (AC-4). A send back without a
// comment is refused (WF-3). With a comment it returns the instance to the
// request step as revision 2, clears the holder and records the note to Sam in
// the same commit (I2, SE-2); the timeline keeps revision 1 and revision 2
// (WF-3). A send back from a stale view is refused at once (I5). The path is
// deterministic (I6).

test('#48 a send back needs a comment and returns the instance to the named step as revision 2 (S11)', () => {
  // One shared source, so every recorded operation gets a distinct ID (I1).
  const sources = deps()

  // The start routes the request to the request step, whose starter target
  // resolves to Sam (S06, WF-1, I13).
  const started = startInstance(flow, data, STARTER, sources, resolve, starterGrants)
  const startState = apply(started.operation, emptyState)
  expect(started.instance.currentStep).toBe(REQUEST_STEP)
  expect(started.instance.assignees).toEqual([
    { step: REQUEST_STEP, target: { starter: 'starter' }, members: [STARTER] },
  ])

  // Sam submits: he claims the request step and completes it with submit, so
  // the instance advances to the registrar step (S09, WF-1).
  const opened = startState.log.length
  const atRequest: Instance = { ...started.instance, version: opened }
  const claimedRequest = claim(atRequest, STARTER, opened, sources)
  expect(claimedRequest.accepted).toBe(true)
  let state = applyAction(claimedRequest, startState)
  const submitted = complete(
    claimedRequest.instance,
    STARTER,
    'submit',
    claimedRequest.instance.version ?? 0,
    { flow: SLUG, definition, grants: samGrants },
    sources
  )
  expect(submitted.accepted).toBe(true)
  expect(submitted.instance.currentStep).toBe(REGISTRAR_STEP)
  state = applyAction(submitted, state)

  // The engine records the assignees of a step when it starts it (S06, I13).
  // The registrar step starts now, so the story resolves its team snapshot, so
  // that Jordan can claim it.
  const registrarAssignees = resolveAssignees(definition.steps[1], resolve)
  expect(registrarAssignees).toEqual([
    { step: REGISTRAR_STEP, target: { team: REGISTRAR_TEAM }, members: REGISTRAR_MEMBERS },
  ])
  const atRegistrar: Instance = {
    ...submitted.instance,
    assignees: [...submitted.instance.assignees, ...registrarAssignees],
  }
  const claimedRegistrar = claim(atRegistrar, JORDAN, atRegistrar.version ?? 0, sources)
  expect(claimedRegistrar.accepted).toBe(true)
  expect(claimedRegistrar.instance.holder).toBe(JORDAN)
  const held = claimedRegistrar.instance
  state = applyAction(claimedRegistrar, state)

  const context: SendBackContext = { flow: SLUG, grants: jordanGrants }

  // (a) WF-3: a send back without a comment is refused, and the instance is
  // unchanged.
  const noComment = sendBack(held, JORDAN, REQUEST_STEP, '', held.version ?? 0, context, sources)
  expect(noComment.accepted).toBe(false)
  expect(noComment.operation).toBeUndefined()
  expect(noComment.outbox).toBeUndefined()
  expect(noComment.instance).toBe(held)
  expect(noComment.reason).toContain('comment')
  const blank = sendBack(held, JORDAN, REQUEST_STEP, '   ', held.version ?? 0, context, sources)
  expect(blank.accepted).toBe(false)
  expect(blank.reason).toContain('comment')

  // (c) AC-4: Jordan holds `step.outcome:send_back` on the registrar step and
  // no other scope, so the engine refuses approve, and it refuses a send back
  // from a principal that lacks the send back scope.
  const approve = complete(
    held,
    JORDAN,
    'approve',
    held.version ?? 0,
    { flow: SLUG, definition, grants: jordanGrants },
    sources
  )
  expect(approve.accepted).toBe(false)
  expect(approve.operation).toBeUndefined()
  expect(approve.reason).toContain('step.outcome:approve')
  const noScope = sendBack(
    held,
    JORDAN,
    REQUEST_STEP,
    COMMENT,
    held.version ?? 0,
    { flow: SLUG, grants: [] },
    sources
  )
  expect(noScope.accepted).toBe(false)
  expect(noScope.reason).toContain('step.outcome:send_back')

  // (b) WF-3, I2, SE-2: the send back with a comment returns the instance to
  // the request step as revision 2, clears the holder, and records the note to
  // Sam in the same operation.
  const sent = sendBack(held, JORDAN, REQUEST_STEP, COMMENT, held.version ?? 0, context, sources)
  expect(sent.accepted).toBe(true)
  expect(sent.instance.currentStep).toBe(REQUEST_STEP)
  expect(sent.instance.holder).toBeUndefined()
  expect(sent.instance.revisions).toEqual({ [REQUEST_STEP]: 2 })
  expect(sent.instance.version).toBe((held.version ?? 0) + 1)
  expect(sent.operation?.type).toBe(STEP_SENT_BACK)
  expect(sent.operation?.actor).toBe(JORDAN)
  expect(sent.outbox).toEqual({
    operation: SENT_BACK_NOTIFICATION,
    target: EMAIL_CONNECTOR,
    payload: {
      to: STARTER,
      step: REQUEST_STEP,
      from: REGISTRAR_STEP,
      actor: JORDAN,
      comment: COMMENT,
    },
  })
  expect(sent.operation?.payload).toEqual({
    from: REGISTRAR_STEP,
    to: REQUEST_STEP,
    comment: COMMENT,
    revision: 2,
    outbox: [sent.outbox],
  })

  // One apply commits the state change and its note together (I2): the outbox
  // is the projection of that one event.
  const afterSent = applySendBack(sent, state)
  expect(outboxOf(afterSent.log)).toEqual([sent.outbox])

  // The timeline shows both revisions of the request step (WF-3): revision 1 is
  // the start that routed the instance to request, and revision 2 is the send
  // back.
  expect(revisionsOnTimeline(afterSent.log, REQUEST_STEP)).toEqual([1, 2])

  // (d) I5: a send back based on the stale view, the version before the claim,
  // is refused at once, so the instance moves back once.
  const stale = sendBack(held, JORDAN, REQUEST_STEP, COMMENT, opened, context, sources)
  expect(stale.accepted).toBe(false)
  expect(stale.operation).toBeUndefined()
  expect(stale.instance).toBe(held)
  expect(stale.reason).toContain('stale')

  // A principal that is not the holder may not send the step back (WF-3).
  const outsider = sendBack(
    held,
    STARTER,
    REQUEST_STEP,
    COMMENT,
    held.version ?? 0,
    { flow: SLUG, grants: samGrants },
    sources
  )
  expect(outsider.accepted).toBe(false)
  expect(outsider.reason).toContain('does not hold')

  // (e) I6: the same inputs give the same result.
  const runOnce = (): SendBackResult =>
    sendBack(held, JORDAN, REQUEST_STEP, COMMENT, held.version ?? 0, context, deps())
  expect(runOnce()).toEqual(runOnce())
})
