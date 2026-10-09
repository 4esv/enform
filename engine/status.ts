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
//
// Scaffolding. The status line and the visibility rules land in the next
// commit. Until they do, every function here refuses to read, so the story's
// first check fails; the story test is marked `test.fails` with the issue
// number, per CONTRIBUTING.md, so the suite stays green.

import type { Grant } from './authorize.js'
import type { FlowDefinition, JsonValue } from './definition.js'
import type { Instance } from './instance.js'
import type { ActorId, Log } from './operation.js'
import type { SkippedStep } from './workflow.js'

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
 * The status of an instance (VT-1, VT-2, S14). This is the scaffold: it
 * refuses to read until the status line lands, so the story proves the missing
 * behavior.
 */
export function status(_instance: Instance, _definition: FlowDefinition, _log: Log): Status {
  throw new Error('status: the status line is not implemented yet (S14)')
}

/**
 * The notes that the log records, in log order (I4, VT-3). This is the
 * scaffold: it refuses to read until the notes land.
 */
export function notesOf(_log: Log): readonly Note[] {
  throw new Error('status: the notes are not implemented yet (S14)')
}

/**
 * The notes that one actor may read (VT-3, I8). This is the scaffold: it
 * refuses to read until the visibility rules land.
 */
export function visibleNotes(
  _actor: ActorId,
  _notes: readonly Note[],
  _context: StatusContext
): readonly Note[] {
  throw new Error('status: the note visibility is not implemented yet (S14)')
}

/**
 * The guarded values that one actor may read (VT-4, I8). This is the scaffold:
 * it refuses to read until the visibility rules land.
 */
export function visibleValues(
  _values: readonly GuardedValue[],
  _grants: readonly Grant[]
): readonly GuardedValue[] {
  throw new Error('status: the value visibility is not implemented yet (S14)')
}

/**
 * The view of an instance that one actor reads (VT-3, VT-4, AC-5, I8). This is
 * the scaffold: it refuses to read until the status and the visibility rules
 * land.
 */
export function visibleTo(
  _actor: ActorId,
  _instance: Instance,
  _context: StatusContext,
  _values: readonly GuardedValue[] = []
): StatusView {
  throw new Error('status: the instance view is not implemented yet (S14)')
}
