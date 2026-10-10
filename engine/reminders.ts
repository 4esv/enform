// Issue #49, S12, SE-3, SE-4, SE-5, I2, I3, I6, I7: reminders and escalation.
//
// This is the scaffold of the S12 model. The story suite
// `stories/S12-reminders-escalation` states the acceptance and fails on
// purpose (`test.fails`, #49) until the implementation lands: the functions
// below return no timer yet, so the first reminder check genuinely fails while
// the suite stays green. The constants and the types are final; the bodies are
// the scaffold. S12: a task that waits in silence reminds people after each
// interval of idle time (SE-3) and escalates once at the deadline (SE-4); a
// completion before the deadline cancels the task's timers in the same event
// (SE-5, I2). Each side effect is an outbox entry with the I3 identity of its
// timer (I3), and every function is pure and deterministic (I6).

import type { ActionResult, CompletionContext } from './action.js'
import type { Version } from './concurrency.js'
import type { Instance } from './instance.js'
import type { ActorId, OperationDeps } from './operation.js'
import type { OutboxEntry } from './outbox.js'

/** The connector operation that sends a reminder (SE-2, SE-3). */
export const REMINDER_EMAIL = 'send-reminder'

/** The connector operation that sends an escalation (SE-2, SE-4). */
export const ESCALATION_EMAIL = 'send-escalation'

/** The rule name of a reminder in the I3 identity (I3, SE-3). */
export const REMINDER_RULE = 'reminder'

/** The rule name of an escalation in the I3 identity (I3, SE-4). */
export const ESCALATION_RULE = 'escalation'

/** The payload key that carries the I3 keys of the timers that a completion cancelled (SE-5). */
export const CANCELLED_TIMERS = 'cancelledTimers'

/** The timers that a flow configures for one step (SE-3, SE-4): flow settings, injected by the caller. */
export type TimerSettings = {
  readonly instance: string
  readonly since: number
  readonly reminderInterval: number
  readonly deadline: number
  readonly escalationTargets: readonly string[]
}

/** The result of a completion that cancels the task's timers (S12, SE-5, I2). */
export type CompletedTask = ActionResult & {
  readonly cancelled: readonly OutboxEntry[]
}

/** The reminder side effects that are due at `now` (SE-3, I3, I6). The scaffold returns none. */
export function dueReminders(
  _instance: Instance,
  _timers: TimerSettings,
  _now: number
): readonly OutboxEntry[] {
  return []
}

/** The escalation side effect that fires at the deadline (SE-4, I3, I6). The scaffold returns none. */
export function dueEscalation(
  _instance: Instance,
  _timers: TimerSettings,
  _now: number
): OutboxEntry | undefined {
  return undefined
}

/** Complete the current step before the deadline and cancel its timers (S12, SE-5, I2). */
export function completeBeforeDeadline(
  instance: Instance,
  _actor: ActorId,
  _outcome: string,
  _expectedVersion: Version,
  _context: CompletionContext,
  _timers: TimerSettings,
  _deps: OperationDeps
): CompletedTask {
  return { accepted: false, instance, cancelled: [] }
}
