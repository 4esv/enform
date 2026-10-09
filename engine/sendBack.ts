// Issue #48, S11, WF-2, WF-3, AC-4, SE-2, I2, I5, I6, I8, I14: send an
// instance back for revision.
//
// S11: Jordan, a registrar reviewer, holds only `step.outcome:send_back` on
// the registrar step, so he may send a task back and may not approve it
// (AC-4). A send back is the outcome `send_back` whose transition moves the
// instance BACK to a named step instead of forward (WF-2). It requires a
// comment (WF-3): the engine refuses a send back with no comment. The step
// that the instance revisits records the next revision, and the timeline keeps
// both revisions (WF-3). Only the holder may send the step back, and the
// engine refuses a view that is stale at once, so a holder with a stale view
// re-reads (I5). On acceptance the note to the people who must act on the
// target step rides in the same operation (I2, SE-2): one apply commits the
// state change and its side effect together. The function is pure and
// deterministic (I6): it reads no clock, no random source and no I/O of its
// own, and the injected operation sources come in as arguments.
//
// Scaffolding. The send back mechanism lands in the next commit. Until it
// does, this stub refuses every send back, so the story's first check fails;
// the story test is marked `test.fails` with the issue number, per
// CONTRIBUTING.md, so the suite stays green.

import type { Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'
import type { OutboxEntry } from './outbox.js'

/** The versioned event type of a send back (S11, WF-3). */
export const STEP_SENT_BACK = 'step.sent-back@1'

/**
 * The connector operation that carries the note of a send back to the people
 * who must act on the target step (SE-2, the "sent back" template).
 */
export const SENT_BACK_NOTIFICATION = 'send-sent-back'

/**
 * The context that a send back needs (S11): the flow slug, so the engine can
 * build the resource of the current step and authorize `step.outcome:send_back`
 * on it (AC-4), and the scopes that apply to the acting principal; when they
 * are given the engine authorizes the outcome from them (I8). It mirrors
 * `CompletionContext` (action.ts).
 */
export type SendBackContext = {
  readonly flow: string
  readonly grants?: readonly Grant[]
}

/**
 * The result of a send back (I5, WF-3, AC-4, I14). `accepted` says whether the
 * engine moved the instance back. When it did not, the instance is unchanged,
 * `operation` and `outbox` are absent, and `reason` says why: no current step,
 * a stale view, an empty comment, an actor that is not the holder, or an actor
 * that may not choose the send back outcome.
 */
export type SendBackResult = {
  readonly accepted: boolean
  readonly instance: Instance
  /** The operation that records the accepted send back (I14); absent when the engine refused. */
  readonly operation?: Operation
  /** The note to the target step (I2, SE-2); absent when the engine refused. */
  readonly outbox?: OutboxEntry
  /** Why the engine refused the send back (I5, WF-3, AC-4); absent when it accepted. */
  readonly reason?: string
}

/**
 * Send the current step of an instance back to a named step (S11, WF-3). This
 * is the scaffold: it refuses the send back until the mechanism lands, so the
 * story proves the missing behavior.
 */
export function sendBack(
  instance: Instance,
  _actor: ActorId,
  _toStep: string,
  _comment: string,
  _expectedVersion: Version,
  _context: SendBackContext,
  _deps: OperationDeps
): SendBackResult {
  return { accepted: false, instance, reason: 'step: the send back is not implemented yet (S11)' }
}
