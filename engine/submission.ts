// Issue #43, S06, ID-2, AC-1, I2, I6, I10, I13, I14, SE-1: start and submit a
// submission.
//
// S06: Sam opens a form link, fills it in and submits it. The engine never
// creates an anonymous draft (ID-2): a start needs a signed-in principal, and
// only the engine decides whether that principal may start (AC-1, I8), through
// the grants that apply to it. A start routes the draft to the assignees of the
// first step whose skip condition is false (WF-1, I10) and stamps the instance
// with its definition version and those assignees (DF-2, I13). A submit marks
// the instance submitted and, in the same operation, records the assignment
// email that the first assignee receives (I2, SE-1): one apply commits the
// state change and its side effect together, and a worker delivers it later.
// Both functions are pure and deterministic (I6): they read no clock, no
// random source and no I/O, and the injected sources come in as arguments.

import type { Grant } from './authorize.js'
import type { ConditionData } from './condition.js'
import type { Flow } from './flow.js'
import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'
import type { TargetResolver } from './routing.js'

/** The versioned event type of a start (S06, MVP.md 9.1). */
export const INSTANCE_STARTED = 'instance.started@1'

/** The versioned event type of a submit (S06, MVP.md 9.1). */
export const INSTANCE_SUBMITTED = 'instance.submitted@1'

/** The connector operation that sends the assignment email (SE-1, SE-2: task assigned). */
export const ASSIGNMENT_EMAIL = 'send-assignment'

/** The connector that delivers email (SE-1). */
export const EMAIL_CONNECTOR = 'connector-smtp'

/** The result of a start: the draft instance and the operation that recorded it (S06, I14). */
export type StartedInstance = {
  readonly instance: Instance
  readonly operation: Operation
}

/** The result of a submit: the submitted instance and the operation that recorded it (S06, I2). */
export type SubmittedInstance = {
  readonly instance: Instance
  readonly operation: Operation
}

/**
 * Start a submission (S06, ID-2, AC-1, DF-2, I10, I13). A start needs a
 * signed-in principal (ID-2), and when `grants` are given the acting principal
 * must hold `instance.start` on `flow:<slug>` (AC-1, I8); the caller passes its
 * own grants and those of the groups and the teams that it belongs to, as
 * `grantsOf` reads them from the log. The function routes the draft to the
 * assignees of the first step whose skip condition is false (WF-1, I10) and
 * stamps the instance with the content hash of the flow's latest published
 * version (DF-2, I13). It is pure and deterministic (I6).
 */
export function startInstance(
  _flow: Flow,
  _data: ConditionData,
  _actor: ActorId | undefined,
  _deps: OperationDeps,
  _resolve: TargetResolver,
  _grants?: readonly Grant[]
): StartedInstance {
  throw new Error('submission: the start of a submission is not implemented yet (issue #43)')
}

/**
 * Submit a submission (S06, I2, SE-1). The instance becomes submitted, and one
 * operation records both the mark and the assignment email that the first
 * assignee receives, so one apply commits the state change and its side effect
 * together (I2). The engine records the email; a worker delivers it later
 * (SE-1). The function is pure and deterministic (I6).
 */
export function submitInstance(
  _instance: Instance,
  _actor: ActorId,
  _deps: OperationDeps
): SubmittedInstance {
  throw new Error('submission: the submit of a submission is not implemented yet (issue #43)')
}
