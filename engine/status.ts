// Issue #51, S14, VT-1, VT-2, VT-3, VT-4, AC-1, AC-4, AC-5, WF-1, WF-3, S05,
// S11, I4, I6, I8, I14: the status of a submission, and the notes and the
// fields that one actor may read.
//
// S14: Sam reads where his request is. The status is a projection of the
// instance and the log (I4): the position and the total of the steps, the
// current step, its holder and its state in plain language (VT-1, VT-2). The
// state tells "waiting to be opened" from "opened, in progress" (S14), and a
// skipped step carries the condition that skipped it, read from the log's
// `step.skipped@1` events (S05, WF-1). Every read is authorized (I8): a
// starter always reads their own instance (AC-5), and the notes and the
// guarded values that an actor may not see are absent from the view (VT-3,
// VT-4). The functions are pure and deterministic (I6): they read no clock,
// no random source and no I/O.

import { authorize, type Grant } from './authorize.js'
import type { FlowDefinition, JsonValue } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId, Event, Log } from './operation.js'
import { STEP_SENT_BACK } from './sendBack.js'
import { type SkippedStep, STEP_SKIPPED } from './workflow.js'

/** The plain-language state of an instance (VT-2, S14). */
export type StatusState = 'waiting' | 'in-progress' | 'done' | 'withdrawn' | 'cancelled'

/** The status line of an instance (VT-1, VT-2, S14). */
export type Status = {
  /** The 1-based position of the active step in the definition (VT-1). */
  readonly step: number
  /** The number of steps in the definition (VT-1). */
  readonly totalSteps: number
  /**
   * The key of the active step (WF-1). It is absent when the instance is done
   * or closed, because no step is open then.
   */
  readonly currentStep?: string
  /** The principal that holds the active step (S09, AS-2); absent when nobody claimed it. */
  readonly holder?: ActorId
  /** The state in plain language (VT-2, S14). */
  readonly state: StatusState
  /** The steps that a condition skipped, with the condition that skipped them (S05). */
  readonly skipped: readonly SkippedStep[]
}

/**
 * One note on the timeline (VT-3): the comment that an attributed event
 * records on a step. A send back records one to the step that it addresses
 * (WF-3, S11), and the people who act on that step read it.
 */
export type Note = {
  /** The step that the note sits on (WF-3). */
  readonly step: string
  /** Who recorded the note (I14). */
  readonly actor: ActorId
  /** The comment itself (WF-3). */
  readonly comment: string
}

/**
 * One value that a scope guards (VT-4, FM-3, I8). Form fields arrive with
 * FM-1; until they do, a guarded value is the unit of a restricted read: the
 * `authorize` check on its scope and resource decides whether the actor sees
 * it.
 */
export type GuardedValue = {
  /** The key of the value, for example a form field key. */
  readonly key: string
  readonly value: JsonValue
  /** The scope that reads it, for example `instance.timeline`. */
  readonly scope: string
  /** What the scope applies to: `org`, `flow:<slug>` or `flow:<slug>/step:<key>`. */
  readonly resource: string
}

/** The status that one actor reads, with the notes and the values it may see (VT-3, VT-4, I8). */
export type StatusView = {
  /** Whether the actor may read the instance at all (I8, AC-5). */
  readonly readable: boolean
  /** The status line; absent when the actor may not read the instance (I8). */
  readonly status?: Status
  /** The notes that the actor may read (VT-3, I8). */
  readonly notes: readonly Note[]
  /** The guarded values that the actor may read (VT-4, I8). */
  readonly values: readonly GuardedValue[]
}

/**
 * The context that a status read needs (S14): the flow slug, the definition
 * that the instance runs on, the log (the single source of truth, I4) and the
 * scopes that apply to the acting principal (AC-1, I8). It mirrors
 * `CompletionContext` (action.ts) and `SendBackContext` (sendBack.ts).
 */
export type StatusContext = {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly log: Log
  readonly grants: readonly Grant[]
}

/**
 * The status of an instance (VT-1, VT-2, S14). It is a pure function of the
 * instance, the definition and the log (I6): the position and the total come
 * from the definition, the state from the instance's markers, and the skipped
 * steps from the log's `step.skipped@1` events (S05). It reads no clock, no
 * random source and no I/O.
 */
export function status(instance: Instance, definition: FlowDefinition, log: Log): Status {
  const totalSteps = definition.steps.length
  return {
    step: activePosition(instance, definition) ?? totalSteps,
    totalSteps,
    currentStep: instance.currentStep,
    holder: instance.holder,
    state: statusState(instance),
    skipped: skippedSteps(log),
  }
}

/**
 * The notes that the log records, in log order (I4, VT-3). A note is the
 * comment that an attributed event records on a step: a send back records one
 * to the step that it addresses (WF-3, S11), and a completion that carries a
 * comment sits on the step that it completed. An event without a comment
 * records no note.
 */
export function notesOf(log: Log): readonly Note[] {
  const notes: Note[] = []
  for (const event of log) {
    const note = readNote(event)
    if (note !== undefined) notes.push(note)
  }
  return notes
}

/**
 * The notes that one actor may read (VT-3, I8). An actor reads a note when it
 * wrote the note, or when it holds one of the outcome scopes of the note's
 * step (AC-4): a note is the discussion of the people who act on the step, so
 * an actor without the step's outcome scope does not read it.
 */
export function visibleNotes(
  actor: ActorId,
  notes: readonly Note[],
  context: StatusContext
): readonly Note[] {
  return notes.filter((note) => note.actor === actor || holdsOutcomeScope(context, note.step))
}

/**
 * The guarded values that one actor may read (VT-4, I8). Each value names the
 * scope and the resource that read it, and the engine authorizes the read
 * exactly as it authorizes a write (AC-1): a value whose scope the actor does
 * not hold is absent from the result.
 */
export function visibleValues(
  values: readonly GuardedValue[],
  grants: readonly Grant[]
): readonly GuardedValue[] {
  return values.filter((value) => authorize(grants, value.scope, value.resource))
}

/**
 * The view of an instance that one actor reads (VT-3, VT-4, AC-5, I8). The
 * starter always reads the status of their own instance (AC-5), an assignee
 * reads the instance that carries its task (AS-2), and so does a principal
 * that holds `instance.read` on the flow. The view then holds the status, the
 * notes that the actor may read (VT-3) and the guarded values that the actor
 * may read (VT-4). An actor that may not read the instance reads no status, no
 * note and no value. The function is pure and deterministic (I6).
 */
export function visibleTo(
  actor: ActorId,
  instance: Instance,
  context: StatusContext,
  values: readonly GuardedValue[] = []
): StatusView {
  if (!mayRead(actor, instance, context)) {
    return { readable: false, notes: [], values: [] }
  }
  return {
    readable: true,
    status: status(instance, context.definition, context.log),
    notes: visibleNotes(actor, notesOf(context.log), context),
    values: visibleValues(values, context.grants),
  }
}

/** Whether an actor may read an instance (AC-5, AS-2, I8): its starter, its assignee, or `instance.read`. */
function mayRead(actor: ActorId, instance: Instance, context: StatusContext): boolean {
  if (actor === instance.starter) return true
  if (instance.assignees.some((assignee) => assignee.members.includes(actor))) return true
  return authorize(context.grants, 'instance.read', `flow:${context.flow}`)
}

/** The state of an instance in plain language (VT-2, S14). */
function statusState(instance: Instance): StatusState {
  if (instance.withdrawal === 'withdrawn') return 'withdrawn'
  if (instance.withdrawal === 'cancelled') return 'cancelled'
  if (instance.done === true) return 'done'
  if (instance.holder !== undefined) return 'in-progress'
  return 'waiting'
}

/**
 * The 1-based position of the active step in the definition (VT-1). The active
 * step is the current step, or the step that a withdraw or a cancel closed
 * (WF-5). A done instance has no active step, so the caller uses the last
 * position.
 */
function activePosition(instance: Instance, definition: FlowDefinition): number | undefined {
  const key = instance.currentStep ?? instance.previousStep
  if (key === undefined) return undefined
  const index = definition.steps.findIndex((step) => step.key === key)
  return index === -1 ? undefined : index + 1
}

/** The skipped steps that the log records, in log order (S05, WF-1). */
function skippedSteps(log: Log): readonly SkippedStep[] {
  const skipped: SkippedStep[] = []
  for (const event of log) {
    if (event.type !== STEP_SKIPPED) continue
    const step = event.payload.step
    const condition = event.payload.condition
    if (typeof step === 'string' && condition !== undefined) {
      skipped.push({ step, condition: condition as JsonValue })
    }
  }
  return skipped
}

/** Read the note that one event records (VT-3, WF-3); absent when the event records none. */
function readNote(event: Event): Note | undefined {
  if (event.actor === undefined) return undefined
  const comment = event.payload.comment
  if (typeof comment !== 'string') return undefined
  const step = event.type === STEP_SENT_BACK ? event.payload.to : event.payload.step
  if (typeof step !== 'string') return undefined
  return { step, actor: event.actor, comment }
}

/** Whether an actor holds one of the outcome scopes of a step (AC-4, I8). */
function holdsOutcomeScope(context: StatusContext, step: string): boolean {
  const definitionStep = context.definition.steps.find((candidate) => candidate.key === step)
  if (definitionStep === undefined) return false
  const resource = `flow:${context.flow}/step:${step}`
  return (definitionStep.outcomes ?? []).some((outcome) =>
    authorize(context.grants, `step.outcome:${outcome}`, resource)
  )
}
