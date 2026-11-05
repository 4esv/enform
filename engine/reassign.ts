// Issue #256, WF-5, AS-2, AS-3, MVP.md 5.6 (`task.reassign`), I2, I5, I8,
// I14, A1: release a task to the pool, and reassign a task to a principal.
//
// A holder releases their own task; a flow owner, who holds `task.reassign`
// on the flow, releases or reassigns any task, also one they are no target of
// (MVP.md 5.6). A release clears the holder, so the step's assignees claim it
// again (AS-2). A reassign makes the named principal the holder and an
// assignee of the step, so they read and complete the task, and tells them in
// the same operation (I2, SE-2). Both carry the version of the view they are
// based on and refuse a stale one (I5), and both are attributed operations on
// the append-only log (I14) that a compensating event can undo (WF-5). The
// functions are pure and deterministic (I6).

import type { ActionResult } from './action.js'
import { authorize, type Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import { type Instance, mergeAssignees } from './instance.js'
import { type ActorId, createOperation, type OperationDeps } from './operation.js'
import { createOutboxOperation } from './outbox.js'
import { assignmentEmails } from './submission.js'
import { TASK_REASSIGNED, TASK_RELEASED } from './undo.js'

export { TASK_REASSIGNED, TASK_RELEASED }

/** The flow the task belongs to and the grants that apply to the actor (I8). */
export type ReassignContext = {
  readonly flow: string
  readonly grants: readonly Grant[]
}

/**
 * Release the current task to the pool (WF-5, AS-2, I5). The holder releases
 * their own task without any scope; a flow owner (`task.reassign` on the flow)
 * releases anyone's and gives a reason. A task nobody holds cannot be
 * released, and a stale view is refused.
 */
export function release(
  instance: Instance,
  actor: ActorId,
  reason: string | undefined,
  expectedVersion: Version,
  context: ReassignContext,
  deps: OperationDeps
): ActionResult {
  const step = instance.currentStep
  if (step === undefined || instance.submitted === false) {
    return { accepted: false, instance, reason: 'the instance has no open task to release' }
  }
  const version = instance.version ?? 0
  if (expectedVersion !== version) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the view is stale, refresh and retry`,
    }
  }
  const holder = instance.holder
  if (holder === undefined) {
    return { accepted: false, instance, reason: `step ${step}: nobody holds the task` }
  }
  if (holder !== actor && !isOwner(context)) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: ${actor} neither holds the task nor holds task.reassign on flow:${context.flow}`,
    }
  }
  const released: Instance = { ...instance, holder: undefined, version: version + 1 }
  const trimmed = reason?.trim()
  const change = {
    instanceId: instance.instanceId,
    step,
    holder,
    ...(trimmed === undefined || trimmed === '' ? {} : { reason: trimmed }),
  }
  return {
    accepted: true,
    instance: released,
    operation: createOperation(TASK_RELEASED, change, deps, actor),
  }
}

/**
 * Reassign the current task to a principal (WF-5, MVP.md 5.6, I2, I5, I8).
 * Only a flow owner (`task.reassign` on the flow) may, with a reason. The
 * named principal becomes the holder and an assignee of the step, so the read
 * and the completion authorize them (AS-2, AC-4), and the task-assigned email
 * rides in the same operation (SE-2). A stale view is refused.
 */
export function reassign(
  instance: Instance,
  actor: ActorId,
  to: ActorId,
  reason: string,
  expectedVersion: Version,
  context: ReassignContext,
  deps: OperationDeps
): ActionResult {
  const step = instance.currentStep
  if (step === undefined || instance.submitted === false) {
    return { accepted: false, instance, reason: 'the instance has no open task to reassign' }
  }
  if (reason.trim() === '') {
    return { accepted: false, instance, reason: `step ${step}: a reassign needs a reason (WF-5)` }
  }
  if (to.trim() === '') {
    return { accepted: false, instance, reason: `step ${step}: a reassign needs a principal` }
  }
  const version = instance.version ?? 0
  if (expectedVersion !== version) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the view is stale, refresh and retry`,
    }
  }
  if (!isOwner(context)) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: ${actor} lacks task.reassign on flow:${context.flow}`,
    }
  }
  // The new holder joins the step's assignees without removing anyone (AS-2,
  // I13): the people the step resolved to keep their right to read it.
  const assignees = [{ step, target: { user: to }, members: [to] }]
  const moved: Instance = {
    ...instance,
    holder: to,
    version: version + 1,
    queue: undefined,
    assignees: mergeAssignees(instance.assignees, assignees),
  }
  const change = {
    instanceId: instance.instanceId,
    step,
    ...(instance.holder === undefined ? {} : { from: instance.holder }),
    to,
    reason: reason.trim(),
    assignees,
  }
  const operation = createOutboxOperation(
    TASK_REASSIGNED,
    change,
    assignmentEmails(assignees),
    deps,
    actor
  )
  return { accepted: true, instance: moved, operation }
}

/** Whether the actor owns the flow: holds `task.reassign` on it (MVP.md 3, 5.6). */
function isOwner(context: ReassignContext): boolean {
  return authorize(context.grants, 'task.reassign', `flow:${context.flow}`)
}
