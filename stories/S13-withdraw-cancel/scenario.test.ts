import { expect, test } from 'vitest'
import { type ActionResult, claim, complete } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Instance } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { resolveAssignees } from '../../engine/routing.js'
import { EMAIL_CONNECTOR, startInstance } from '../../engine/submission.js'
import {
  type CloseContext,
  type CloseResult,
  cancel,
  INSTANCE_CANCELLED,
  INSTANCE_UNDONE,
  INSTANCE_WITHDRAWN,
  type UndoResult,
  undoWithdrawOrCancel,
  WITHDRAW_CANCEL_NOTIFICATION,
  withdraw,
} from '../../engine/withdraw.js'
import {
  ANA,
  data,
  definition,
  flow,
  PRIYA,
  priyaGrants,
  REGISTRAR_MEMBERS,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  resolve,
  SLUG,
  STARTER,
  samGrants,
  starterGrants,
} from './scenario.js'

/** The reason that Sam gives for the withdrawal (S13, WF-4). */
const WITHDRAW_REASON = 'Dropped a class'

/** The reason that Priya gives for the cancellation (S13, AC-5, MVP.md 5.6). */
const CANCEL_REASON = 'Already submitted as #4411'

/** The time that the withdraw and the cancel happen (I6): the clock is injected. */
const CLOSED_AT = 1_700_000_000_000

/** One day: the undo period that the flow allows (WF-5, S13). */
const UNDO_PERIOD = 24 * 60 * 60 * 1000

/** The injected sources of the path (I6): the clock is a settable time and the IDs are `op-N`. */
function deps(clock: () => number): OperationDeps {
  let next = 0
  return {
    clock,
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

/** Apply the operation that an accepted close returned (S13, I14). */
function applyClose(result: CloseResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the close was refused: ${result.reason}`)
  return apply(result.operation, state)
}

/** Apply the compensating operation that an accepted undo returned (S13, WF-5, I4). */
function applyUndo(result: UndoResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the undo was refused: ${result.reason}`)
  return apply(result.operation, state)
}

// Issue #50: Sam's request is at the registrar step, held by Ana. Sam withdraws
// his own instance (WF-4, AC-5), and the engine closes the open task and
// notifies Ana in the same commit (SE-5, I2). Priya cancels with
// `instance.cancel` (AC-5, AC-1), and a principal without the scope is refused.
// An undo within the flow's undo period restores the previous step and holder
// as a compensating event (WF-5, I4); a stale view or a time past the period is
// refused. The path is deterministic (I6).

test('#50 a starter withdraws, an authorized principal cancels, and an undo restores the step (S13)', () => {
  // One shared source, so every recorded operation gets a distinct ID (I1).
  let now = CLOSED_AT
  const sources = deps(() => now)

  // The start routes the request to the request step, whose starter target
  // resolves to Sam, and records him as the starter (S06, WF-1, AC-5).
  const started = startInstance(flow, data, STARTER, sources, resolve, starterGrants)
  expect(started.instance.starter).toBe(STARTER)
  let state = apply(started.operation, emptyState)

  // Sam submits his own request (S09, WF-1): he claims the request step and
  // completes it with submit, so the instance advances to the registrar step.
  const opened = state.log.length
  const atRequest: Instance = { ...started.instance, version: opened }
  const claimedRequest = claim(atRequest, STARTER, opened, sources)
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

  // The registrar task starts now, so the story resolves its team snapshot, so
  // that Ana can claim it (S06, I13).
  const registrarAssignees = resolveAssignees(definition.steps[1], resolve)
  expect(registrarAssignees).toEqual([
    { step: REGISTRAR_STEP, target: { team: REGISTRAR_TEAM }, members: REGISTRAR_MEMBERS },
  ])
  const atRegistrar: Instance = {
    ...submitted.instance,
    assignees: [...submitted.instance.assignees, ...registrarAssignees],
  }
  const claimedRegistrar = claim(atRegistrar, ANA, atRegistrar.version ?? 0, sources)
  expect(claimedRegistrar.accepted).toBe(true)
  expect(claimedRegistrar.instance.holder).toBe(ANA)
  const held = claimedRegistrar.instance
  state = applyAction(claimedRegistrar, state)

  // (a) AC-5: a principal that is not the starter may not withdraw the
  // instance, so the request stays with its holder.
  const notStarter = withdraw(held, ANA, WITHDRAW_REASON, sources)
  expect(notStarter.accepted).toBe(false)
  expect(notStarter.operation).toBeUndefined()
  expect(notStarter.outbox).toBeUndefined()
  expect(notStarter.instance).toBe(held)
  expect(notStarter.reason).toContain('starter')

  // (b) AC-5, AC-1: a cancel needs `instance.cancel` on the flow. Ana holds no
  // such scope, so the engine refuses her cancel.
  const noScope = cancel(held, ANA, CANCEL_REASON, { flow: SLUG, grants: starterGrants }, sources)
  expect(noScope.accepted).toBe(false)
  expect(noScope.operation).toBeUndefined()
  expect(noScope.reason).toContain('instance.cancel')

  // MVP.md 5.6: a cancel needs a reason, so an empty one is refused.
  const noReason = cancel(held, PRIYA, '', { flow: SLUG, grants: priyaGrants }, sources)
  expect(noReason.accepted).toBe(false)
  expect(noReason.reason).toContain('reason')

  // (c) WF-4, SE-5, I2: Sam withdraws his own instance. The engine closes the
  // open task, marks the instance withdrawn, records the previous step and
  // holder for the undo, and returns the notification to Ana in the same
  // operation.
  const withdrawn = withdraw(held, STARTER, WITHDRAW_REASON, sources)
  expect(withdrawn.accepted).toBe(true)
  expect(withdrawn.instance.currentStep).toBeUndefined()
  expect(withdrawn.instance.holder).toBeUndefined()
  expect(withdrawn.instance.withdrawal).toBe('withdrawn')
  expect(withdrawn.instance.previousStep).toBe(REGISTRAR_STEP)
  expect(withdrawn.instance.previousHolder).toBe(ANA)
  expect(withdrawn.instance.closedBy).toBe(STARTER)
  expect(withdrawn.instance.closedAt).toBe(CLOSED_AT)
  expect(withdrawn.instance.version).toBe((held.version ?? 0) + 1)
  expect(withdrawn.operation?.type).toBe(INSTANCE_WITHDRAWN)
  expect(withdrawn.operation?.actor).toBe(STARTER)
  expect(withdrawn.outbox).toEqual({
    operation: WITHDRAW_CANCEL_NOTIFICATION,
    target: EMAIL_CONNECTOR,
    payload: { to: ANA, step: REGISTRAR_STEP, actor: STARTER, reason: WITHDRAW_REASON },
  })
  expect(withdrawn.operation?.payload).toEqual({
    step: REGISTRAR_STEP,
    holder: ANA,
    reason: WITHDRAW_REASON,
    outbox: [withdrawn.outbox],
  })
  state = applyClose(withdrawn, state)
  expect(outboxOf(state.log)).toEqual([withdrawn.outbox])

  // (d) WF-5, I4: an undo within the period restores the previous step and
  // holder as a compensating event. It appends a new event and never rewrites
  // the withdrawal: the log keeps both.
  now = CLOSED_AT + UNDO_PERIOD
  const restored = undoWithdrawOrCancel(
    withdrawn.instance,
    STARTER,
    withdrawn.instance.version ?? 0,
    UNDO_PERIOD,
    now,
    sources
  )
  expect(restored.accepted).toBe(true)
  expect(restored.instance.currentStep).toBe(REGISTRAR_STEP)
  expect(restored.instance.holder).toBe(ANA)
  expect(restored.instance.withdrawal).toBeUndefined()
  expect(restored.instance.previousStep).toBeUndefined()
  expect(restored.instance.version).toBe((withdrawn.instance.version ?? 0) + 1)
  expect(restored.operation?.type).toBe(INSTANCE_UNDONE)
  expect(restored.operation?.actor).toBe(STARTER)
  expect(restored.operation?.payload).toEqual({
    undoOf: 'withdrawn',
    step: REGISTRAR_STEP,
    holder: ANA,
  })
  state = applyUndo(restored, state)
  expect(state.log.filter((event) => event.type === INSTANCE_WITHDRAWN)).toHaveLength(1)
  expect(state.log.filter((event) => event.type === INSTANCE_UNDONE)).toHaveLength(1)

  // (e) I5: an undo based on the stale view, the version before the close, is
  // refused at once, so the task is restored once.
  const stale = undoWithdrawOrCancel(
    withdrawn.instance,
    STARTER,
    held.version ?? 0,
    UNDO_PERIOD,
    now,
    sources
  )
  expect(stale.accepted).toBe(false)
  expect(stale.operation).toBeUndefined()
  expect(stale.instance).toBe(withdrawn.instance)
  expect(stale.reason).toContain('stale')

  // (f) WF-5: an undo past the undo period is refused.
  const late = undoWithdrawOrCancel(
    withdrawn.instance,
    STARTER,
    withdrawn.instance.version ?? 0,
    UNDO_PERIOD,
    CLOSED_AT + UNDO_PERIOD + 1,
    sources
  )
  expect(late.accepted).toBe(false)
  expect(late.operation).toBeUndefined()
  expect(late.reason).toContain('period')

  // WF-5: the principal that did not close the instance may not undo it.
  const wrongActor = undoWithdrawOrCancel(
    withdrawn.instance,
    ANA,
    withdrawn.instance.version ?? 0,
    UNDO_PERIOD,
    now,
    sources
  )
  expect(wrongActor.accepted).toBe(false)

  // (g) WF-4, AC-5, I2: Priya holds `instance.cancel` on the flow, so she
  // cancels the instance. The engine closes the open task and notifies Ana in
  // the same operation, and an undo within the period restores her.
  now = CLOSED_AT
  const context: CloseContext = { flow: SLUG, grants: priyaGrants }
  const cancelled = cancel(held, PRIYA, CANCEL_REASON, context, sources)
  expect(cancelled.accepted).toBe(true)
  expect(cancelled.instance.withdrawal).toBe('cancelled')
  expect(cancelled.instance.previousStep).toBe(REGISTRAR_STEP)
  expect(cancelled.instance.previousHolder).toBe(ANA)
  expect(cancelled.instance.closedBy).toBe(PRIYA)
  expect(cancelled.operation?.type).toBe(INSTANCE_CANCELLED)
  expect(cancelled.operation?.actor).toBe(PRIYA)
  expect(cancelled.outbox?.payload).toEqual({
    to: ANA,
    step: REGISTRAR_STEP,
    actor: PRIYA,
    reason: CANCEL_REASON,
  })

  const restoredCancel = undoWithdrawOrCancel(
    cancelled.instance,
    PRIYA,
    cancelled.instance.version ?? 0,
    UNDO_PERIOD,
    now + UNDO_PERIOD,
    sources
  )
  expect(restoredCancel.accepted).toBe(true)
  expect(restoredCancel.instance.currentStep).toBe(REGISTRAR_STEP)
  expect(restoredCancel.instance.holder).toBe(ANA)
  expect(restoredCancel.operation?.payload).toEqual({
    undoOf: 'cancelled',
    step: REGISTRAR_STEP,
    holder: ANA,
  })

  // (h) I6: the same inputs give the same result.
  const runOnce = (): CloseResult =>
    withdraw(
      held,
      STARTER,
      WITHDRAW_REASON,
      deps(() => CLOSED_AT)
    )
  expect(runOnce()).toEqual(runOnce())
})
