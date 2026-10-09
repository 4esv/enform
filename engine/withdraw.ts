// Issue #50, S13, WF-4, WF-5, AC-1, AC-5, SE-2, SE-5, I2, I4, I6, I14:
// withdraw or cancel a submission, and undo it.
//
// Scaffold (commit 1 of 2): the types and the event types below are the
// contract that the S13 scenario builds on, and the functions refuse every
// action so that the scenario fails as expected and the suite stays green
// (MVP.md 11.1). The full model lands in the next commit (#50).

import type { Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'
import type { OutboxEntry } from './outbox.js'

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
 * their own instance (AC-5). The scaffold refuses every withdrawal (#50).
 */
export function withdraw(
  instance: Instance,
  actor: ActorId,
  reason: string,
  deps: OperationDeps
): CloseResult {
  return { accepted: false, instance, reason: scaffold(`withdraw by ${actor}: ${reason}`, deps) }
}

/**
 * Cancel the instance (S13, WF-4, AC-5, AC-1, I2). The acting principal holds
 * `instance.cancel` on the flow (AC-5, AC-1). The scaffold refuses every
 * cancellation (#50).
 */
export function cancel(
  instance: Instance,
  actor: ActorId,
  reason: string,
  context: CloseContext,
  deps: OperationDeps
): CloseResult {
  return {
    accepted: false,
    instance,
    reason: scaffold(`cancel by ${actor} on flow:${context.flow}: ${reason}`, deps),
  }
}

/**
 * Undo a withdrawal or a cancellation within the flow's undo period (S13,
 * WF-5, I4). The scaffold refuses every undo (#50).
 */
export function undoWithdrawOrCancel(
  instance: Instance,
  actor: ActorId,
  expectedVersion: Version,
  undoPeriod: number,
  now: number,
  deps: OperationDeps
): UndoResult {
  const what = `undo by ${actor} at ${now} within ${undoPeriod} ms (v${expectedVersion})`
  return { accepted: false, instance, reason: scaffold(what, deps) }
}

/** The refusal that the scaffold returns, with the injected time (I6). */
function scaffold(what: string, deps: OperationDeps): string {
  return `${what} (not implemented yet, #50) at ${deps.clock()}`
}
