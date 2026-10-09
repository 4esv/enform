// Issue #47, S10, AS-3, WF-5, A1, A2, I2, I5, I6, I14: take over a claimed task.
//
// S10: Lee claimed the registrar task and went on vacation. Any eligible
// assignee of the step can take over a claimed task (AS-3), but only when the
// holder has been idle for at least the idle period that the step allows. The
// idle period is a step setting in the flow definition (a later schema change),
// so this engine takes it as an argument, and the story injects it. The claim
// time is the `at` of the `step.claimed@1` event on the log, so the engine
// derives the idle time from the log and records no new field. A takeover is an
// attributed reassign (I14, WF-5): the operation records from whom to whom,
// when and why, and it carries the notification to the previous holder in the
// same commit (I2). The function is pure and deterministic (I6): it reads no
// clock, no random source and no I/O of its own; the caller passes `now`, the
// idle period and the injected operation sources.

import { STEP_CLAIMED } from './action.js'
import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import type { ActorId, Log, Operation, OperationDeps } from './operation.js'
import { createOutboxOperation, type OutboxEntry } from './outbox.js'
import { EMAIL_CONNECTOR } from './submission.js'

/** The versioned event type of a takeover (S10, AS-3). */
export const STEP_TAKEN_OVER = 'step.taken-over@1'

/**
 * The connector operation that notifies the previous holder that the task was
 * taken over (SE-2, the "taken over" template).
 */
export const TAKEOVER_NOTIFICATION = 'send-takeover'

/**
 * The result of a takeover (I5, AS-3, I14). `accepted` says whether the engine
 * reassigned the holder. When it did not, the instance is unchanged,
 * `operation` and `outbox` are absent, and `reason` says why: a stale view, an
 * actor that is not an assignee, an unclaimed step, or a holder whose idle time
 * is below the idle period, with the remaining time.
 */
export type TakeoverResult = {
  readonly accepted: boolean
  readonly instance: Instance
  /** The operation that records the accepted reassign (I14); absent when the engine refused. */
  readonly operation?: Operation
  /** The notification to the previous holder (I2, SE-2); absent when the engine refused. */
  readonly outbox?: OutboxEntry
  /** Why the engine refused the takeover (I5, AS-3); absent when it accepted. */
  readonly reason?: string
}

/**
 * Take over the current step of an instance from its holder (S10, AS-3, WF-5,
 * I5, I14). The engine accepts the takeover only when the acting principal is
 * an assignee of the current step (AS-3), the view is not stale (I5), and the
 * holder has been idle for at least `idleTimeout`, measured from the claim
 * event's `at` up to the injected `now`. When the view is stale it refuses at
 * once, so the caller re-reads and retries (I5). When the idle time is below
 * the idle period it refuses and names the remaining time, so the actor sees
 * how long the holder must be idle. On acceptance the engine reassigns the
 * holder (WF-5), records the attribution `{ from, to, when, why }` on the
 * operation (I14), and returns the notification to the previous holder, which
 * the operation carries in the same commit (I2). The function is pure and
 * deterministic (I6).
 */
export function takeover(
  instance: Instance,
  actor: ActorId,
  reason: string,
  now: number,
  idleTimeout: number,
  expectedVersion: Version,
  log: Log,
  deps: OperationDeps
): TakeoverResult {
  const step = instance.currentStep
  if (step === undefined) {
    return { accepted: false, instance, reason: 'the instance has no current step to take over' }
  }
  const version = currentVersion(instance)
  if (expectedVersion !== version) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the view is stale, refresh and retry`,
    }
  }
  if (!isAssignee(instance, actor)) {
    return { accepted: false, instance, reason: `step ${step}: ${actor} is not an assignee` }
  }
  const holder = instance.holder
  if (holder === undefined) {
    return { accepted: false, instance, reason: `step ${step}: the task is not claimed` }
  }
  const claimedAt = claimTime(log, step, holder)
  if (claimedAt === undefined) {
    return { accepted: false, instance, reason: `step ${step}: the task has no claim to take over` }
  }
  const idle = now - claimedAt
  if (idle < idleTimeout) {
    return { accepted: false, instance, reason: idleRefusal(step, holder, idle, idleTimeout) }
  }
  const taken: Instance = { ...instance, holder: actor, version: version + 1 }
  const change = { step, from: holder, to: actor, when: now, why: reason }
  const outbox = notification(holder, actor, step, reason)
  const operation = createOutboxOperation(STEP_TAKEN_OVER, change, [outbox], deps, actor)
  return { accepted: true, instance: taken, operation, outbox }
}

/** The version of the log that an instance view reflects (I5). An absent version is the empty log. */
function currentVersion(instance: Instance): Version {
  return instance.version ?? 0
}

/** Whether the acting principal is an assignee of the instance's current step (AS-3). */
function isAssignee(instance: Instance, actor: ActorId): boolean {
  const step = instance.currentStep
  return instance.assignees.some(
    (assignee) => assignee.step === step && assignee.members.includes(actor)
  )
}

/**
 * The time of the claim that the holder is based on (S10): the `at` of the
 * last `step.claimed@1` event for this step and this holder. It is absent when
 * the log has no such claim, so the idle time has no start.
 */
function claimTime(log: Log, step: string, holder: ActorId): number | undefined {
  let at: number | undefined
  for (const event of log) {
    if (event.type !== STEP_CLAIMED) continue
    if (event.payload.step !== step) continue
    if (event.payload.holder !== holder) continue
    at = event.at
  }
  return at
}

/** Why the engine refused a takeover for too little idle time, with the remaining time (AS-3). */
function idleRefusal(step: string, holder: ActorId, idle: number, idleTimeout: number): string {
  const remaining = idleTimeout - idle
  return `step ${step}: ${holder} is idle for ${idle} ms, so the takeover needs ${remaining} ms more`
}

/** The notification that the previous holder receives when the task is taken over (I2, SE-2). */
function notification(holder: ActorId, actor: ActorId, step: string, reason: string): OutboxEntry {
  return {
    operation: TAKEOVER_NOTIFICATION,
    target: EMAIL_CONNECTOR,
    payload: { to: holder, step, actor, reason },
  }
}
