// Issue #46, S09, AS-2, AC-4, I5, I6, I8, I14, A1, A9: claim and complete a task.
//
// S09: the registrar task shows in the Available tab of Lee and of Ana. To
// open it claims nothing (AS-2): the first person to claim the task owns it,
// and a second claim on the same view is refused, so exactly one succeeds and
// nobody blocks (I5). The holder completes the task with an outcome, and the
// engine authorizes that outcome from the grants of the holder (AC-4, I8): a
// `step.outcome:<name>` scope allows that outcome and no other. A claim and a
// completion each carry the version of the view that they are based on, and a
// stale view is refused at once (I5). Both are attributed operations on the
// append-only log (I14), and both functions are pure and deterministic (I6):
// they read no clock, no random source and no I/O of their own.
//
// This commit is the scaffolding. The bodies of `claim` and `complete` arrive
// with the implementation, so the S09 check below is marked expected to fail.

import type { Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { FlowDefinition } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'

/** The versioned event type of a claim (S09, AS-2). */
export const STEP_CLAIMED = 'step.claimed@1'

/** The versioned event type of a completion (S09, WF-2). */
export const STEP_COMPLETED = 'step.completed@1'

/**
 * The result of a claim or a completion (I5, AS-2, AC-4). `accepted` says
 * whether the engine applied the transition. When it did not, the instance is
 * unchanged, `operation` is absent and `reason` says why: a stale view, an
 * actor that is not an assignee or not the holder, or an outcome that the
 * actor may not choose.
 */
export type ActionResult = {
  readonly accepted: boolean
  readonly instance: Instance
  /** The operation that records the accepted change (I14); absent when the engine refused. */
  readonly operation?: Operation
  /** Why the engine refused the action (I5, AS-2, AC-4); absent when it accepted. */
  readonly reason?: string
}

/**
 * The context that a completion needs (S09): the flow slug and the definition
 * that the instance runs on, so the engine can authorize the outcome on the
 * current step (AC-4) and advance to the next step (WF-1). `grants` are the
 * scopes that apply to the acting principal; when they are given the engine
 * authorizes the outcome from them (I8).
 */
export type CompletionContext = {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly grants?: readonly Grant[]
}

/**
 * Claim the current step of an instance (S09, AS-2, AC-4, I5). The first
 * person to claim the task owns it, so the engine accepts the claim only when
 * the acting principal is an assignee of the current step and the claim is
 * based on the current version of the log (I5). When the version is stale it
 * refuses at once and names the holder, so a second person sees that the first
 * claimed the task just now; when the principal is not an assignee it refuses
 * too. Nobody waits and the caller re-reads (I5). On acceptance the instance
 * records the holder and the operation records the claim (I14).
 */
export function claim(
  _instance: Instance,
  _actor: ActorId,
  _expectedVersion: Version,
  _deps: OperationDeps
): ActionResult {
  throw new Error('action: claim is not implemented yet (#46)')
}

/**
 * Complete the current step of an instance with an outcome (S09, AC-4, I5).
 * Only the holder may complete the step, and the engine refuses a completion
 * that is based on a stale version of the log at once, so a holder with a
 * stale view re-reads and there is no second completion (I5). The engine
 * authorizes the outcome from the grants that apply to the holder (AC-4, I8):
 * the holder must hold `step.outcome:<outcome>` on the step. On acceptance the
 * instance advances to the next step, or is marked done when the step was the
 * last, and the operation records the outcome (I14).
 */
export function complete(
  _instance: Instance,
  _actor: ActorId,
  _outcome: string,
  _expectedVersion: Version,
  _context: CompletionContext,
  _deps: OperationDeps
): ActionResult {
  throw new Error('action: complete is not implemented yet (#46)')
}
