// Issue #244, S14, VT-1, VT-2, VT-3, WF-1, WF-3, I4, I6, I8, A4: the per-step
// tracker of an instance.
//
// VT-2: each instance has a step tracker. Each step shows one state: not
// reached, unopened, opened, completed, skipped or sent back. S14: Sam reads
// the tracker on the instance page, so a skipped step shows the condition that
// skipped it and the open step shows who holds it.
//
// The tracker is a projection of the instance, the definition that the instance
// is pinned to (DF-2) and the log (I4). It folds the instance's own events in
// log order: the start's `skipped` payload, a `step.skipped@1`, a claim or a
// takeover, a completion, a send back, and a withdraw, a cancel or an undo.
// Events of another instance never reach the fold, so the tracker never shows
// another instance's history. The tracker never invents a state: a step with no
// event and no current step is `not-reached`. It reads no clock, no random
// source and no I/O (I6), so two reads of the same log answer the same tracker.

import { nextStep, STEP_CLAIMED, STEP_COMPLETED } from './action.js'
import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId, Event, Log } from './operation.js'
import { MINUTE_MS } from './reminders.js'
import { STEP_SENT_BACK } from './sendBack.js'
import { INSTANCE_STARTED } from './submission.js'
import { STEP_TAKEN_OVER } from './takeover.js'
import { INSTANCE_CANCELLED, INSTANCE_UNDONE, INSTANCE_WITHDRAWN } from './withdraw.js'
import { STEP_SKIPPED } from './workflow.js'

/** The state of one step of the tracker (VT-2, S14). */
export type TrackerState =
  | 'not-reached'
  | 'unopened'
  | 'opened'
  | 'completed'
  | 'skipped'
  | 'sent-back'

/**
 * One step of the tracker (VT-2, S14). It is one definition step in definition
 * order. `holder` is the holder of the current open step, `condition` is the
 * condition that skipped the step (the VT-2 reason), and `comment` is the
 * send-back comment that reopened the current step. `startAt` is when the
 * instance entered the step, `lastActivityAt` is the newest event for it, and
 * `dueAt` is its deadline counted from `startAt` (SE-4, VT-2).
 */
export type TrackerStep = {
  /** The definition key of the step (WF-1). */
  readonly key: string
  /** The one state the step shows (VT-2). */
  readonly state: TrackerState
  /** The principal that holds the current open step (S09, AS-2). */
  readonly holder?: ActorId
  /** The condition that skipped the step (S05, WF-1); the VT-2 reason. */
  readonly condition?: JsonValue
  /** The comment that sent the current step back (WF-3, S11). */
  readonly comment?: string
  /**
   * When the instance entered the step (VT-2, S14): the start for the first
   * active step, the completion that advanced to it, or the send back that
   * reopened it. It is absent for a step that the instance never entered.
   */
  readonly startAt?: number
  /**
   * The newest event for the step (VT-2, S14): a claim (including a takeover),
   * a completion or a send back. It is absent until the log records one, so a
   * step that waits unopened carries only its start time.
   */
  readonly lastActivityAt?: number
  /**
   * The due time of the step (VT-2, SE-4): the time the instance entered the
   * step plus the step's `deadlineMinutes`. It is absent when the step sets no
   * deadline or the instance never entered it.
   */
  readonly dueAt?: number
  /** The Unroutable queue of the current unopened step (I10, AS-5); absent when the task resolved to a person. */
  readonly queue?: string
}

/**
 * Read the per-step tracker of one instance (S14, VT-2, I4, I6). The tracker
 * holds one entry per definition step, in definition order. It follows the
 * instance's own events on the log, so a send back moves the state to the
 * target step, a completion keeps the history of an earlier step, and a done
 * instance shows every step completed or skipped. A withdrawn or cancelled
 * instance shows the history up to the close, with the step that the close
 * named as the step it was at the close and no new state. The function is pure
 * and deterministic (I6).
 */
export function trackerOf(
  instance: Instance,
  definition: FlowDefinition,
  log: Log
): readonly TrackerStep[] {
  const folded = fold(instance, definition, log)
  return definition.steps.map((step) => entry(step, folded))
}

/** The state of every step as the instance's own events record it. */
type Folded = {
  readonly states: ReadonlyMap<string, TrackerState>
  readonly conditions: ReadonlyMap<string, JsonValue>
  readonly comments: ReadonlyMap<string, string>
  /** When the instance entered each step (VT-2, S14). */
  readonly starts: ReadonlyMap<string, number>
  /** The newest event for each step (VT-2, S14). */
  readonly activities: ReadonlyMap<string, number>
  readonly currentStep?: string
  readonly holder?: ActorId
  readonly queue?: string
}

/**
 * Fold the instance's own events into its per-step state (I4). The start is the
 * first event of an instance, so later events act on the state it sets. An
 * instance without an id has no events of its own, so the fold keeps the
 * current step and holder that the instance records.
 */
function fold(instance: Instance, definition: FlowDefinition, log: Log): Folded {
  const states = new Map<string, TrackerState>()
  const conditions = new Map<string, JsonValue>()
  const comments = new Map<string, string>()
  const starts = new Map<string, number>()
  const activities = new Map<string, number>()
  let currentStep = instance.currentStep
  let holder = instance.holder
  let queue = instance.queue
  for (const event of ownEvents(instance, log)) {
    if (event.type === INSTANCE_STARTED) {
      currentStep = stringField(event.payload, 'currentStep') ?? instance.currentStep
      holder = undefined
      queue = stringField(event.payload, 'queue')
      if (currentStep !== undefined) starts.set(currentStep, event.at)
      for (const skipped of readSkipped(event.payload.skipped)) {
        states.set(skipped.step, 'skipped')
        conditions.set(skipped.step, skipped.condition)
      }
      continue
    }
    if (event.type === STEP_CLAIMED) {
      const step = stringField(event.payload, 'step')
      if (step === undefined) continue
      states.set(step, 'opened')
      activities.set(step, event.at)
      holder = stringField(event.payload, 'holder') ?? event.actor
      currentStep = step
      queue = undefined
      continue
    }
    if (event.type === STEP_TAKEN_OVER) {
      const step = stringField(event.payload, 'step')
      if (step === undefined) continue
      states.set(step, 'opened')
      activities.set(step, event.at)
      holder = stringField(event.payload, 'to') ?? event.actor
      currentStep = step
      queue = undefined
      continue
    }
    if (event.type === STEP_COMPLETED) {
      const step = stringField(event.payload, 'step')
      if (step === undefined) continue
      states.set(step, 'completed')
      comments.delete(step)
      activities.set(step, event.at)
      holder = undefined
      const next = nextStep(definition, step)?.key
      if (next !== undefined) starts.set(next, event.at)
      currentStep = next
      queue = stringField(event.payload, 'queue')
      continue
    }
    if (event.type === STEP_SENT_BACK) {
      const to = stringField(event.payload, 'to')
      if (to === undefined) continue
      // The step that sent it back keeps its earlier state (VT-2); the target
      // step is sent back and carries the comment that reopened it (WF-3).
      states.set(to, 'sent-back')
      const comment = stringField(event.payload, 'comment')
      if (comment === undefined) comments.delete(to)
      else comments.set(to, comment)
      // The send back is the newest event for the step it left and for the
      // step it reopens, so both carry it as their last activity (VT-2).
      const from = stringField(event.payload, 'from')
      if (from !== undefined) activities.set(from, event.at)
      starts.set(to, event.at)
      activities.set(to, event.at)
      holder = undefined
      currentStep = to
      queue = stringField(event.payload, 'queue')
      continue
    }
    if (event.type === STEP_SKIPPED) {
      const step = stringField(event.payload, 'step')
      if (step === undefined) continue
      states.set(step, 'skipped')
      if (event.payload.condition !== undefined) {
        conditions.set(step, event.payload.condition as JsonValue)
      }
      continue
    }
    if (event.type === INSTANCE_WITHDRAWN || event.type === INSTANCE_CANCELLED) {
      // The close shows the step it closed and the holder it closed with, and
      // it adds no state of its own (VT-2, S13).
      currentStep = stringField(event.payload, 'step') ?? instance.previousStep
      holder = stringField(event.payload, 'holder')
      queue = undefined
      continue
    }
    if (event.type === INSTANCE_UNDONE) {
      // The undo restores the step and the holder that the close recorded (WF-5).
      currentStep = stringField(event.payload, 'step')
      holder = stringField(event.payload, 'holder')
      queue = undefined
    }
  }
  return { states, conditions, comments, starts, activities, currentStep, holder, queue }
}

/** The events that name this instance (I4); an instance without an id owns none. */
function ownEvents(instance: Instance, log: Log): readonly Event[] {
  if (instance.instanceId === undefined) return []
  return log.filter((event) => event.payload.instanceId === instance.instanceId)
}

/**
 * One tracker entry for a definition step (VT-2). A state that the log records
 * wins. Otherwise the current step is opened when it has a holder and unopened
 * when it has none, and every other step is not reached; the tracker never
 * invents a state. The entry carries the due time when the step sets a deadline
 * and the instance has entered it (VT-2, SE-4).
 */
function entry(step: FlowStep, folded: Folded): TrackerStep {
  const key = step.key
  const recorded = folded.states.get(key)
  const state: TrackerState =
    recorded ??
    (key === folded.currentStep
      ? folded.holder === undefined
        ? 'unopened'
        : 'opened'
      : 'not-reached')
  return {
    key,
    state,
    ...(state === 'opened' && key === folded.currentStep && folded.holder !== undefined
      ? { holder: folded.holder }
      : {}),
    ...(state === 'skipped' && folded.conditions.has(key)
      ? { condition: folded.conditions.get(key) }
      : {}),
    ...(state === 'sent-back' && folded.comments.has(key)
      ? { comment: folded.comments.get(key) }
      : {}),
    ...(folded.starts.has(key) ? { startAt: folded.starts.get(key) } : {}),
    ...(folded.activities.has(key) ? { lastActivityAt: folded.activities.get(key) } : {}),
    ...(step.deadlineMinutes !== undefined && folded.starts.has(key)
      ? { dueAt: (folded.starts.get(key) ?? 0) + step.deadlineMinutes * MINUTE_MS }
      : {}),
    ...(state === 'unopened' && key === folded.currentStep && folded.queue !== undefined
      ? { queue: folded.queue }
      : {}),
  }
}

/** One step that a `skipped` array records, with the condition that skipped it (S05, WF-1). */
type SkippedEntry = {
  readonly step: string
  readonly condition: JsonValue
}

/**
 * The skipped steps that one `skipped` array records (S05, #192). A malformed
 * or absent value records none, so a read never trusts the shape of the log.
 */
function readSkipped(value: unknown): readonly SkippedEntry[] {
  if (!Array.isArray(value)) return []
  const skipped: SkippedEntry[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { step, condition } = entry as Record<string, unknown>
    if (typeof step !== 'string' || condition === undefined) continue
    skipped.push({ step, condition: condition as JsonValue })
  }
  return skipped
}

/** One string field of an event payload; absent when the payload does not carry it. */
function stringField(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}
