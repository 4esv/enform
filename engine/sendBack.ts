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

import { authorize, type Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'
import { createOutboxOperation, type OutboxEntry } from './outbox.js'
import { EMAIL_CONNECTOR } from './submission.js'

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
 * Send the current step of an instance back to a named step (S11, WF-3, AC-4,
 * I5, I2). The engine accepts the send back only when the acting principal is
 * the holder of the current step, the comment is present (WF-3), the view is
 * not stale (I5), and the principal holds `step.outcome:send_back` on the
 * current step (AC-4, I8). A stale view is refused at once, so the caller
 * re-reads and retries (I5), and an empty comment is refused, so every send
 * back carries the note that the person who corrects the request needs
 * (WF-3). On acceptance the engine moves `currentStep` back to `toStep`,
 * records the next revision of that step, clears the holder, and returns the
 * note to the target step, which the operation carries in the same commit
 * (I2, SE-2). The function is pure and deterministic (I6).
 */
export function sendBack(
  instance: Instance,
  actor: ActorId,
  toStep: string,
  comment: string,
  expectedVersion: Version,
  context: SendBackContext,
  deps: OperationDeps
): SendBackResult {
  const step = instance.currentStep
  if (step === undefined) {
    return { accepted: false, instance, reason: 'the instance has no current step to send back' }
  }
  const version = currentVersion(instance)
  if (expectedVersion !== version) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the view is stale, refresh and retry`,
    }
  }
  if (comment.trim().length === 0) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: a send back needs a comment (WF-3)`,
    }
  }
  if (instance.holder !== actor) {
    return { accepted: false, instance, reason: `step ${step}: ${actor} does not hold the step` }
  }
  const resource = stepResource(context.flow, step)
  if (
    context.grants !== undefined &&
    !authorize(context.grants, 'step.outcome:send_back', resource)
  ) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: ${actor} lacks step.outcome:send_back (AC-4)`,
    }
  }
  const revision = revisionOf(instance, toStep) + 1
  const revisions = { ...(instance.revisions ?? {}), [toStep]: revision }
  const sentBack: Instance = {
    ...instance,
    currentStep: toStep,
    holder: undefined,
    revisions,
    version: version + 1,
  }
  const change = { from: step, to: toStep, comment, revision }
  const outbox = note(instance, actor, step, toStep, comment)
  const operation = createOutboxOperation(STEP_SENT_BACK, change, [outbox], deps, actor)
  return { accepted: true, instance: sentBack, operation, outbox }
}

/** The version of the log that an instance view reflects (I5). An absent version is the empty log. */
function currentVersion(instance: Instance): Version {
  return instance.version ?? 0
}

/** The revision that the instance is on for one step (WF-3, S11): its first entry is revision 1. */
function revisionOf(instance: Instance, step: string): number {
  return instance.revisions?.[step] ?? 1
}

/** The resource of one step (MVP.md 5.6): `flow:<slug>/step:<key>`. */
function stepResource(flow: string, key: string): string {
  return `flow:${flow}/step:${key}`
}

/**
 * The note that a send back records to the people who must act on the target
 * step (I2, SE-2): the connector operation, the connector, the recipient, the
 * target step, the step it was sent from, the actor and the comment. The
 * comment is the note that the story shows above the form.
 */
function note(
  instance: Instance,
  actor: ActorId,
  from: string,
  toStep: string,
  comment: string
): OutboxEntry {
  const to = instance.assignees.find((assignee) => assignee.step === toStep)?.members[0]
  const payload = { to, step: toStep, from, actor, comment }
  return { operation: SENT_BACK_NOTIFICATION, target: EMAIL_CONNECTOR, payload }
}
