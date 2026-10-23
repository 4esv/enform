// Issue #49, S12, SE-3, SE-4, SE-5, I2, I3, I6, I7: reminders and escalation.
//
// S12: a task that waits in silence must remind people and then escalate. A
// reminder fires after each full interval of idle time (SE-3), one per elapsed
// interval, and an escalation fires once at the deadline, notifies a person and
// adds targets without removing the current owner (SE-4). The reminder interval
// and the deadline are flow settings (a later schema change), so this engine
// takes them, the instance identity and the time the task started as arguments,
// and the story injects them (as S10 injects the idle period and S13 the undo
// period). Each side effect is an outbox entry whose I3 identity is that of the
// timer: the instance, the step, the rule and the occurrence. The key comes
// from the entry alone, so the same timer always gives the same key and fires a
// maximum of one time (I3). A completion that happens before the deadline
// cancels the task's timers in the same event (SE-5, I2): the completion
// records the keys that it cancelled and emits no reminder and no escalation,
// so one `apply` changes the state and cancels the timers together. The
// functions are pure and deterministic (I6): they read no clock, no random
// source and no I/O of their own; the caller passes `now`.

import { type ActionResult, type CompletionContext, complete } from './action.js'
import type { Version } from './concurrency.js'
import type { FlowStep, Target } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'
import type { OutboxEntry } from './outbox.js'
import { sideEffectKey } from './sideEffects.js'
import { EMAIL_CONNECTOR } from './submission.js'

/** The connector operation that sends a reminder (SE-2, SE-3). */
export const REMINDER_EMAIL = 'send-reminder'

/** The connector operation that sends an escalation (SE-2, SE-4). */
export const ESCALATION_EMAIL = 'send-escalation'

/**
 * The event type that records one timer firing (SE-3, SE-4, SE-5, I2, I3). The
 * worker appends it with the timer id and the one outbox entry that the timer
 * carries, so the firing and its side effect commit in one event.
 */
export const TIMER_FIRED = 'timer.fired@1'

/** One minute in milliseconds (SE-3, SE-4). */
export const MINUTE_MS = 60_000

/** The rule name of a reminder in the I3 identity (I3, SE-3). */
export const REMINDER_RULE = 'reminder'

/** The rule name of an escalation in the I3 identity (I3, SE-4). */
export const ESCALATION_RULE = 'escalation'

/**
 * The reserved payload key that carries the I3 keys of the timers that a
 * completion cancelled (SE-5). The completion event holds them, so a worker
 * never delivers a timer of a task that already completed, and the state change
 * and the cancellation share one commit (I2).
 */
export const CANCELLED_TIMERS = 'cancelledTimers'

/**
 * The timers that a flow configures for one step (SE-3, SE-4). The reminder
 * interval and the deadline are flow settings, and the instance record carries
 * no id and no timestamp yet, so the caller injects all of these. `since` is
 * the time the task started, from the injected clock (I6), and the reminder
 * intervals count from it. `escalationTargets` are the targets that the
 * escalation adds (SE-4).
 */
export type TimerSettings = {
  /** The instance that the task belongs to, for the I3 identity (I3). */
  readonly instance: string
  /** The time the task started, from the injected clock (I6, SE-3). */
  readonly since: number
  /** The interval between two reminders (SE-3), a flow setting. */
  readonly reminderInterval: number
  /** The deadline of the task (SE-4), a flow setting. */
  readonly deadline: number
  /** The targets that the escalation adds at the deadline (SE-4). */
  readonly escalationTargets: readonly string[]
}

/**
 * The settings that one flow step gives its timers (SE-3, SE-4, S12): the
 * instance that the task belongs to, the time the task entered the step, and
 * the person that a timer notifies. The step itself supplies the interval, the
 * deadline and the escalation targets.
 */
export type StepTimerSettings = {
  /** The instance that the task belongs to, for the I3 identity (I3). */
  readonly instance: string
  /** The time the task entered the step, from the injected clock (I6). */
  readonly since: number
  /** The person that the timer notifies; absent when the step has no assignee. */
  readonly to?: string
}

/**
 * One timer that a step schedules (SE-3, SE-4, SE-5): the reminder or the
 * escalation, the time it fires, and the outbox entry that it carries when it
 * fires. The timer row's id is the entry's I3 key (sideEffects.ts), so the same
 * timer always has the same id (I3, I6).
 */
export type ScheduledTimer = {
  readonly kind: 'reminder' | 'escalation'
  readonly fireAt: number
  readonly entry: OutboxEntry
}

/**
 * The timers that one step schedules from its flow settings (SE-3, SE-4, S12).
 * A step with `reminderMinutes` schedules one reminder per elapsed interval up
 * to its deadline, and a step with `deadlineMinutes` schedules the escalation
 * at the deadline. A step with a reminder interval and no deadline schedules
 * its first reminder; `nextReminderTimer` schedules the following one when the
 * previous fires. A step with neither setting schedules nothing. The function
 * is pure and deterministic (I6).
 */
export function timersOfStep(
  step: FlowStep,
  settings: StepTimerSettings
): readonly ScheduledTimer[] {
  const interval = step.reminderMinutes === undefined ? undefined : step.reminderMinutes * MINUTE_MS
  const timers: ScheduledTimer[] = []
  if (interval !== undefined) {
    const last =
      step.deadlineMinutes === undefined
        ? 1
        : Math.floor((step.deadlineMinutes * MINUTE_MS) / interval)
    for (let occurrence = 1; occurrence <= last; occurrence += 1) {
      const timer = reminderTimer(step, settings, occurrence)
      if (timer !== undefined) timers.push(timer)
    }
  }
  const escalation = escalationTimer(step, settings)
  if (escalation !== undefined) timers.push(escalation)
  return timers
}

/**
 * The reminder after one that has fired (SE-3, S12): the next occurrence that
 * a step without a deadline schedules, so a task that waits keeps reminding
 * until it completes. An absent reminder setting has no next reminder. The
 * function is pure and deterministic (I6).
 */
export function nextReminderTimer(
  step: FlowStep,
  settings: StepTimerSettings,
  occurrence: number
): ScheduledTimer | undefined {
  if (step.reminderMinutes === undefined) return undefined
  return reminderTimer(step, settings, occurrence)
}

/** One reminder timer of one occurrence, or undefined when the step sets no interval (SE-3). */
function reminderTimer(
  step: FlowStep,
  settings: StepTimerSettings,
  occurrence: number
): ScheduledTimer | undefined {
  if (step.reminderMinutes === undefined) return undefined
  const interval = step.reminderMinutes * MINUTE_MS
  const timers: TimerSettings = {
    instance: settings.instance,
    since: settings.since,
    reminderInterval: interval,
    // Only the escalation reads the deadline; the reminder's entry never does.
    deadline: 0,
    escalationTargets: [],
  }
  return {
    kind: 'reminder',
    fireAt: settings.since + occurrence * interval,
    entry: reminder(timers, step.key, occurrence, settings.to),
  }
}

/** The escalation timer of a step, or undefined when the step sets no deadline (SE-4). */
function escalationTimer(step: FlowStep, settings: StepTimerSettings): ScheduledTimer | undefined {
  if (step.deadlineMinutes === undefined) return undefined
  const deadline = settings.since + step.deadlineMinutes * MINUTE_MS
  const timers: TimerSettings = {
    instance: settings.instance,
    since: settings.since,
    reminderInterval: 0,
    deadline,
    escalationTargets: (step.escalationTargets ?? []).map(targetLabel),
  }
  return {
    kind: 'escalation',
    fireAt: deadline,
    entry: escalation(timers, step.key, settings.to),
  }
}

/** The stable text of one target, as the escalation payload names it (SE-4, AS-1). */
function targetLabel(target: Target): string {
  const [kind] = Object.keys(target)
  return `${kind}:${String((target as Record<string, string>)[kind])}`
}

/** The result of a completion that cancels the task's timers (S12, SE-5, I2). */
export type CompletedTask = ActionResult & {
  /**
   * The timers that the completion cancelled (SE-5), in reminder order and
   * then the escalation. Empty when the engine refused the completion or the
   * instance had no open task. They are never emitted, so a cancelled timer
   * fires no side effect (I2, I3).
   */
  readonly cancelled: readonly OutboxEntry[]
}

/**
 * The reminder side effects of a task that are due at `now` (SE-3, I3, I6):
 * one entry per full interval of idle time since `since`. Each entry carries
 * the I3 identity of its timer, the instance, the step, the reminder rule and
 * the occurrence, so its key is deterministic and it fires a maximum of one
 * time (I3). An instance with no open task, or an interval that is not
 * positive, has no reminder. The function is pure and deterministic (I6).
 */
export function dueReminders(
  instance: Instance,
  timers: TimerSettings,
  now: number
): readonly OutboxEntry[] {
  const step = openStep(instance)
  if (step === undefined) return []
  const to = recipient(instance, step)
  return reminderOccurrences(timers.since, timers.reminderInterval, now).map((occurrence) =>
    reminder(timers, step, occurrence, to)
  )
}

/**
 * The escalation side effect that fires at the deadline (SE-4, I3, I6). It is
 * due when `now` has reached the deadline, it notifies a person and adds the
 * targets that the flow configures, and it never removes the current owner
 * (SE-4). Its I3 identity is the instance, the step, the escalation rule and
 * the deadline as the occurrence, so it fires a maximum of one time (I3). An
 * instance with no open task has no escalation. Pure and deterministic (I6).
 */
export function dueEscalation(
  instance: Instance,
  timers: TimerSettings,
  now: number
): OutboxEntry | undefined {
  const step = openStep(instance)
  if (step === undefined) return undefined
  if (now < timers.deadline) return undefined
  return escalation(timers, step, recipient(instance, step))
}

/**
 * Complete the current step before the deadline and cancel its timers (S12,
 * SE-5, I2). The engine completes the step as `complete` does, and when it
 * accepts, the one operation also records the I3 keys of the timers that the
 * task scheduled and that the completion cancelled: the reminder occurrences
 * up to the deadline and the escalation. The completion emits no reminder and
 * no escalation side effect, so the state change and the cancellation commit in
 * one event (I2). After the completion the task is no longer open, so no timer
 * of it is ever due (SE-5). The function is pure and deterministic (I6).
 */
export function completeBeforeDeadline(
  instance: Instance,
  actor: ActorId,
  outcome: string,
  expectedVersion: Version,
  context: CompletionContext,
  timers: TimerSettings,
  deps: OperationDeps
): CompletedTask {
  const cancelled = scheduledTimers(instance, timers)
  const result = complete(instance, actor, outcome, {}, expectedVersion, context, deps)
  if (!result.accepted || result.operation === undefined) {
    return { ...result, cancelled: [] }
  }
  const operation: Operation = {
    ...result.operation,
    payload: { ...result.operation.payload, [CANCELLED_TIMERS]: cancelled.map(sideEffectKey) },
  }
  return { ...result, operation, cancelled }
}

/**
 * The timers that a task schedules (SE-3, SE-4, SE-5): every reminder up to
 * its deadline, in interval order, and then its escalation. They are the
 * timers that a completion cancels. An instance with no open task schedules
 * none.
 */
function scheduledTimers(instance: Instance, timers: TimerSettings): readonly OutboxEntry[] {
  const step = openStep(instance)
  if (step === undefined) return []
  const to = recipient(instance, step)
  const reminders = reminderOccurrences(timers.since, timers.reminderInterval, timers.deadline).map(
    (occurrence) => reminder(timers, step, occurrence, to)
  )
  return [...reminders, escalation(timers, step, to)]
}

/** The occurrence numbers of the reminders that are due at or before `upTo` (SE-3). */
function reminderOccurrences(since: number, interval: number, upTo: number): readonly number[] {
  if (interval <= 0) return []
  const last = Math.floor((upTo - since) / interval)
  const occurrences: number[] = []
  for (let occurrence = 1; occurrence <= last; occurrence += 1) occurrences.push(occurrence)
  return occurrences
}

/** One reminder side effect: the email, with the I3 identity of its timer (SE-3, I3). */
function reminder(
  timers: TimerSettings,
  step: string,
  occurrence: number,
  to: string | undefined
): OutboxEntry {
  return {
    operation: REMINDER_EMAIL,
    target: EMAIL_CONNECTOR,
    payload: {
      instance: timers.instance,
      step,
      rule: REMINDER_RULE,
      occurrence: String(occurrence),
      to,
      at: timers.since + occurrence * timers.reminderInterval,
    },
  }
}

/** The escalation side effect: the email, with the I3 identity of its timer (SE-4, I3). */
function escalation(timers: TimerSettings, step: string, to: string | undefined): OutboxEntry {
  return {
    operation: ESCALATION_EMAIL,
    target: EMAIL_CONNECTOR,
    payload: {
      instance: timers.instance,
      step,
      rule: ESCALATION_RULE,
      occurrence: String(timers.deadline),
      to,
      adds: timers.escalationTargets,
    },
  }
}

/**
 * The step of the open task of an instance, or undefined when the instance has
 * no open task (S13, S12): a completed or closed instance has no timers.
 */
function openStep(instance: Instance): string | undefined {
  if (instance.withdrawal !== undefined) return undefined
  return instance.currentStep
}

/**
 * The person that a timer notifies (S12): the holder of the task, or, on a task
 * that nobody claimed, its first assignee, so a timer does not drop the
 * notification silently (I10).
 */
function recipient(instance: Instance, step: string): string | undefined {
  return (
    instance.holder ?? instance.assignees.find((assignee) => assignee.step === step)?.members[0]
  )
}
