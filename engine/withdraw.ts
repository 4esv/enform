// Issue #50, S13, WF-4, WF-5, AC-1, AC-5, SE-2, SE-5, I2, I4, I6, I14:
// withdraw or cancel a submission, and undo it.
//
// S13: Sam withdraws his own request (WF-4, AC-5). Priya cancels an invalid
// request, and she holds `instance.cancel` (AC-5, AC-1). Both close the open
// task, mark the instance withdrawn or cancelled, and notify the holder of the
// closed task in the same commit (SE-5, I2): one `apply` writes the state
// change and its side effect into one event, so they commit together or not at
// all (I2). The starter withdraws only their own instance, and a cancel needs
// the scope (AC-5); every other principal is refused. An undo within the
// flow's undo period is a compensating event (WF-5, I4): it appends a new
// event that restores the previous step and holder, and never rewrites or
// deletes the withdrawal or the cancellation (I4). The functions are pure and
// deterministic (I6): they read no clock, no random source and no I/O of their
// own, and the caller injects the clock, the ID source and the undo period.

import { authorize, type Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'
import { createOutboxOperation, type OutboxEntry } from './outbox.js'
import { EMAIL_CONNECTOR } from './submission.js'

/** The versioned event type of a withdrawal (S13, WF-4). */
export const INSTANCE_WITHDRAWN = 'instance.withdrawn@1'

/** The versioned event type of a cancellation (S13, WF-4). */
export const INSTANCE_CANCELLED = 'instance.cancelled@1'

/** The versioned event type of the undo of a withdrawal or a cancellation (S13, WF-5). */
export const INSTANCE_UNDONE = 'instance.undone@1'

/**
 * The connector operation that notifies the holder that the task was withdrawn
 * or cancelled (SE-2, the "withdrawn or cancelled" template).
 */
export const WITHDRAW_CANCEL_NOTIFICATION = 'send-withdrawn-cancelled'

/** What closed the instance (S13, WF-4): the starter withdrew it, or a principal cancelled it. */
export type CloseKind = 'withdrawn' | 'cancelled'

/**
 * The result of a withdrawal or a cancellation (S13, WF-4, AC-5, I2).
 * `accepted` says whether the engine closed the instance. When it did not, the
 * instance is unchanged, `operation` and `outbox` are absent, and `reason`
 * says why: there is no open task, the instance is already closed, the actor
 * is not the starter, or the actor lacks `instance.cancel`.
 */
export type CloseResult = {
  readonly accepted: boolean
  readonly instance: Instance
  /** The operation that records the accepted close (I14); absent when the engine refused. */
  readonly operation?: Operation
  /** The notification to the holder of the closed task (I2, SE-2); absent when the engine refused. */
  readonly outbox?: OutboxEntry
  /** Why the engine refused the close (S13, AC-5); absent when it accepted. */
  readonly reason?: string
}

/**
 * The context that a cancellation needs (S13, AC-5): the flow slug, so the
 * engine builds the resource `flow:<slug>` and authorizes `instance.cancel`
 * on it (AC-1, I8), and the scopes that apply to the acting principal. It
 * mirrors `SendBackContext` (sendBack.ts) and `CompletionContext` (action.ts).
 */
export type CloseContext = {
  readonly flow: string
  readonly grants?: readonly Grant[]
}

/**
 * The result of the undo of a withdrawal or a cancellation (S13, WF-5, I4).
 * `accepted` says whether the engine restored the previous step and holder.
 * When it did not, the instance is unchanged, `operation` is absent, and
 * `reason` says why: the instance is not closed, the view is stale, the actor
 * did not close it, or the undo period has passed.
 */
export type UndoResult = {
  readonly accepted: boolean
  readonly instance: Instance
  /** The compensating operation that restores the previous step and holder (I4); absent when the engine refused. */
  readonly operation?: Operation
  /** Why the engine refused the undo (S13, WF-5); absent when it accepted. */
  readonly reason?: string
}

/**
 * Withdraw the instance (S13, WF-4, AC-5, I2). Only the starter withdraws
 * their own instance (AC-5): the engine refuses every other principal. On
 * acceptance the engine closes the open task, marks the instance `withdrawn`,
 * records the previous step and holder for the undo (WF-5), and returns the
 * notification to the holder, which the operation carries in the same commit
 * (I2, SE-5). The function is pure and deterministic (I6).
 */
export function withdraw(
  instance: Instance,
  actor: ActorId,
  reason: string,
  deps: OperationDeps
): CloseResult {
  const step = instance.currentStep
  if (step === undefined) {
    return { accepted: false, instance, reason: 'the instance has no open task to withdraw' }
  }
  if (instance.withdrawal !== undefined) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the instance is already ${instance.withdrawal}`,
    }
  }
  if (instance.starter !== actor) {
    return { accepted: false, instance, reason: `step ${step}: ${actor} is not the starter (AC-5)` }
  }
  return close(instance, actor, step, 'withdrawn', INSTANCE_WITHDRAWN, reason, deps)
}

/**
 * Cancel the instance (S13, WF-4, AC-5, AC-1, I2). The acting principal holds
 * `instance.cancel` on the flow (AC-5, AC-1), and the engine refuses every
 * other principal. A cancel needs a reason (MVP.md 5.6), so the engine refuses
 * an empty one. On acceptance the engine closes the open task, marks the
 * instance `cancelled`, records the previous step and holder for the undo
 * (WF-5), and returns the notification to the holder, which the operation
 * carries in the same commit (I2, SE-5). The function is pure and
 * deterministic (I6).
 */
export function cancel(
  instance: Instance,
  actor: ActorId,
  reason: string,
  context: CloseContext,
  deps: OperationDeps
): CloseResult {
  const step = instance.currentStep
  if (step === undefined) {
    return { accepted: false, instance, reason: 'the instance has no open task to cancel' }
  }
  if (instance.withdrawal !== undefined) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the instance is already ${instance.withdrawal}`,
    }
  }
  if (reason.trim().length === 0) {
    return { accepted: false, instance, reason: `step ${step}: a cancel needs a reason` }
  }
  if (
    context.grants !== undefined &&
    !authorize(context.grants, 'instance.cancel', `flow:${context.flow}`)
  ) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: ${actor} lacks instance.cancel (AC-5)`,
    }
  }
  return close(instance, actor, step, 'cancelled', INSTANCE_CANCELLED, reason, deps)
}

/**
 * Undo a withdrawal or a cancellation within the flow's undo period (S13,
 * WF-5, I4). The engine accepts the undo only when the instance is closed, the
 * view is not stale (I5), the acting principal closed it, and at most
 * `undoPeriod` has passed since the close, measured from the close time that
 * the injected clock stamped on the instance up to the injected `now`. On
 * acceptance the engine appends one compensating event that restores the
 * previous step and holder and clears the close marker; it never rewrites or
 * deletes the withdrawal or the cancellation (I4). The function is pure and
 * deterministic (I6).
 */
export function undoWithdrawOrCancel(
  instance: Instance,
  actor: ActorId,
  expectedVersion: Version,
  undoPeriod: number,
  now: number,
  deps: OperationDeps
): UndoResult {
  const kind = instance.withdrawal
  if (kind === undefined) {
    return { accepted: false, instance, reason: 'the instance is not withdrawn or cancelled' }
  }
  const version = currentVersion(instance)
  if (expectedVersion !== version) {
    return { accepted: false, instance, reason: 'the view is stale, refresh and retry' }
  }
  if (instance.closedBy !== actor) {
    return {
      accepted: false,
      instance,
      reason: `${actor} did not withdraw or cancel the instance`,
    }
  }
  const closedAt = instance.closedAt ?? now
  if (now - closedAt > undoPeriod) {
    return {
      accepted: false,
      instance,
      reason: `the instance is ${kind}, and the undo period of ${undoPeriod} ms has passed`,
    }
  }
  const step = instance.previousStep
  const restored: Instance = {
    ...instance,
    currentStep: step,
    holder: instance.previousHolder,
    withdrawal: undefined,
    previousStep: undefined,
    previousHolder: undefined,
    closedAt: undefined,
    closedBy: undefined,
    version: version + 1,
  }
  const change = { undoOf: kind, step, holder: instance.previousHolder }
  const operation = createOperation(INSTANCE_UNDONE, change, deps, actor)
  return { accepted: true, instance: restored, operation }
}

/**
 * Close the open task of an instance and notify its holder (S13, WF-4, SE-5,
 * I2). The state change and its notification share one operation, so one
 * `apply` commits them together (I2). The engine records the previous step,
 * holder, time and actor, so the undo restores the task as a compensating
 * event (WF-5, I4).
 */
function close(
  instance: Instance,
  actor: ActorId,
  step: string,
  kind: CloseKind,
  type: string,
  reason: string,
  deps: OperationDeps
): CloseResult {
  const change = { step, holder: instance.holder, reason }
  const outbox = notification(instance, actor, step, reason)
  const entries = outbox === undefined ? [] : [outbox]
  const operation = createOutboxOperation(type, change, entries, deps, actor)
  const closed: Instance = {
    ...instance,
    currentStep: undefined,
    holder: undefined,
    withdrawal: kind,
    previousStep: step,
    previousHolder: instance.holder,
    closedAt: operation.at,
    closedBy: actor,
    version: currentVersion(instance) + 1,
  }
  return { accepted: true, instance: closed, operation, outbox }
}

/** The version of the log that an instance view reflects (I5). An absent version is the empty log. */
function currentVersion(instance: Instance): Version {
  return instance.version ?? 0
}

/**
 * The notification that the holder of the closed task receives (I2, SE-2).
 * The holder is the recipient; a task that nobody claimed notifies its first
 * assignee, so the close does not drop the notification silently (I10). A
 * task with neither has nobody to notify, and the close records no side
 * effect.
 */
function notification(
  instance: Instance,
  actor: ActorId,
  step: string,
  reason: string
): OutboxEntry | undefined {
  const to = instance.holder ?? instance.assignees.find((a) => a.step === step)?.members[0]
  if (to === undefined) return undefined
  return {
    operation: WITHDRAW_CANCEL_NOTIFICATION,
    target: EMAIL_CONNECTOR,
    payload: { to, step, actor, reason },
  }
}
