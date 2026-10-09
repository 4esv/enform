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
//
// Scaffolding. The takeover mechanism lands in the next commit. Until it does,
// this stub refuses every takeover, so the story's first check fails; the story
// test is marked `test.fails` with the issue number, per CONTRIBUTING.md, so
// the suite stays green.

import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import type { ActorId, Log, Operation, OperationDeps } from './operation.js'
import type { OutboxEntry } from './outbox.js'

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
 * Take over the current step of an instance from its holder (S10, AS-3, WF-5).
 * This is the scaffold: it refuses the takeover until the mechanism lands, so
 * the story proves the missing behavior.
 */
export function takeover(
  instance: Instance,
  _actor: ActorId,
  _reason: string,
  _now: number,
  _idleTimeout: number,
  _expectedVersion: Version,
  _log: Log,
  _deps: OperationDeps
): TakeoverResult {
  return { accepted: false, instance, reason: 'step: the takeover is not implemented yet (S10)' }
}
