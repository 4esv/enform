// Issue #76, FM-3, FM-7, VT-4, S14, DF-2, DX-1, I4, I6, I8, A9: the read half
// of FM-3, the instance as a step sees it, through the public API. #187 put an
// instance id on the log; these functions read it back. #177 wrote the values
// that a form holds; this closes FM-7's "the values are read back through the
// public API only".
//
// The projection folds the events whose payload names one instance, in log
// order, into that instance (I4). Events of another instance never affect the
// result: the fold filters by the instance id before it reads anything else.
// The fold also carries the version counter that the write path keeps (I5,
// #191): the start is version 0, each accepted action advances the counter by
// one, and a submit keeps it, so a completion intent that resolves through the
// projection passes the version that `complete()` expects rather than an
// accidental 0.
// The step-scoped read then narrows the instance to the actor and to the
// current step: the rules of the step (FM-2) decide what it shows, requires
// and collapses, the fields it does not make visible are absent (FM-3),
// the fields it makes editable are editable only for an assignee, and the
// actor must be allowed to read the instance at all (I8). Every function is
// pure and deterministic (I6): it reads no clock, no random source and no I/O.

import { nextStep, STEP_CLAIMED, STEP_COMPLETED } from './action.js'
import {
  type ControlType,
  type FlowDefinition,
  type FlowStep,
  fieldsOf,
  type JsonValue,
} from './definition.js'
import { editableKeys } from './editable.js'
import { publishedByHash } from './flow.js'
import { type Assignee, type Instance, recordAssignees } from './instance.js'
import type { ActorId, Event, Log } from './operation.js'
import { isLiveTarget } from './resolve.js'
import type { TargetResolver } from './routing.js'
import { evaluateRules } from './rules.js'
import { STEP_SENT_BACK } from './sendBack.js'
import { mayRead, type Status, type StatusContext, status } from './status.js'
import { INSTANCE_STARTED, INSTANCE_SUBMITTED } from './submission.js'
import { STEP_TAKEN_OVER } from './takeover.js'
import { INSTANCE_CANCELLED, INSTANCE_UNDONE, INSTANCE_WITHDRAWN } from './withdraw.js'

/**
 * An instance that the projection found on the log (#76, FM-3, DX-1). It always
 * names the instance id, because `instanceOf` finds the start event by that id,
 * so a view that the read returns carries a defined id.
 */
export type ProjectedInstance = Instance & {
  readonly instanceId: string
  /** The flow that the start recorded (#222, I4); it names the flow a read authorizes on. */
  readonly flow: string
}

/**
 * One field of the current step as the read returns it (#228, #230, FM-1, FM-3).
 * It is the part of the definition that the form needs beside the values: the
 * key, the human label when it has one, the control, and the options of a
 * choice control. A field the step does not make visible is absent, exactly as
 * its value is (FM-3 criterion 1).
 */
type InstanceViewField = {
  readonly key: string
  readonly control: ControlType
  readonly label?: string
  readonly options?: readonly string[]
}

/**
 * The instance as one actor and one step see it (#76, FM-3, FM-7, VT-4, I8).
 * `visible` is the field keys the current step shows, in definition order,
 * `editable` is the field keys the actor may change (empty for one that may
 * read but is not an assignee of the step), and `values` holds only the field
 * keys the step makes visible, so a field the step hides is absent from the
 * response (FM-3 criterion 1). The rules of the step (FM-2) decide all of it,
 * and the view carries the two states it did not before: `required` and
 * `collapsed`. `fields` and `outcomes` carry the visible field definitions and
 * the outcomes of the current step, so a step assignee renders and completes
 * the task without reading the whole published definition (#228, AC-4).
 */
export type InstanceView = {
  /** The id of the instance the view describes (DX-1, #187). */
  readonly instanceId: string
  /** The status line of the instance (VT-1, VT-2, S14), reused from status.ts. */
  readonly status: Status
  /** The field keys the current step makes visible, in definition order (FM-3, FM-2). */
  readonly visible: readonly string[]
  /** The field keys the actor may edit on the current step (FM-3, FM-2); empty when the actor is not an assignee. */
  readonly editable: readonly string[]
  /** The field keys the current step requires, after its rules (FM-2). */
  readonly required: readonly string[]
  /** The section keys the current step shows collapsed, after its rules (FM-1, FM-2). */
  readonly collapsed: readonly string[]
  /** The values the instance holds, restricted to the visible field keys (FM-3, FM-7). */
  readonly values: Readonly<Record<string, JsonValue>>
  /**
   * The definitions of the visible fields, in definition order (FM-1, FM-3):
   * the label, the control the form renders and the options it offers. A
   * hidden field is absent, so the read decides the form exactly as it decides
   * the values.
   */
  readonly fields: readonly InstanceViewField[]
  /** The outcomes the current step offers (AC-4, WF-2); empty when it declares none. */
  readonly outcomes: readonly string[]
  /**
   * The version of the instance that this read reflects (I5, #222). A client
   * sends it back with a completion or a claim, so a stale view is refused at
   * once rather than overwriting a newer decision.
   */
  readonly version: number
}

/**
 * Project the log into one instance (#76, I4, I6, DF-2). It folds the events
 * whose payload carries `instanceId`, in log order, and answers undefined when
 * the log holds no start for that instance. The projection needs the definition
 * that the instance is pinned to (DF-2) to advance a completed step, so it
 * reads the version back from the log by the content hash that the start
 * records; a log that holds the instance but not that version gives undefined,
 * so the fold never guesses a transition. It is pure and deterministic (I6),
 * and events of another instance never affect the result.
 */
export function instanceOf(log: Log, instanceId: string): ProjectedInstance | undefined {
  const events = log.filter((event) => event.payload.instanceId === instanceId)
  const start = events.find((event) => event.type === INSTANCE_STARTED)
  if (start === undefined) return undefined
  const definitionVersion = stringField(start.payload, 'definitionVersion')
  const pinned = publishedByHash(log, definitionVersion)
  if (pinned === undefined) return undefined
  let instance = started(start, instanceId)
  for (const event of events) {
    if (event === start) continue
    instance = fold(instance, event, pinned.definition)
  }
  return instance
}

/**
 * Read the instance as one actor and the current step see it (#76, FM-2, FM-3,
 * FM-7, VT-4, I8, #194, AS-4). The engine authorizes the read with the same
 * rule as a status read (mayRead): the starter, an assignee, or a principal
 * that holds `instance.read` on the flow. An actor that may not read the
 * instance answers undefined, which the API serves as 403. The view then holds
 * the field keys the rules of the current step make visible and required, the
 * section keys they collapse, the field keys the actor may edit, and the values
 * restricted to the visible keys. When the caller gives the resolver it reads
 * the directory through, the engine refreshes the live targets (a group or a
 * team) before it authorizes and before it computes the editable keys, so a
 * member who joined after the task was created is an assignee, while a dynamic
 * target keeps the members the instance recorded (AS-4, I13); an absent
 * resolver uses the recorded members as they are. It is pure and deterministic
 * (I6); it reads no clock, no random source and no I/O.
 */
export function readInstance(
  actor: ActorId,
  instance: ProjectedInstance,
  context: StatusContext,
  resolve?: TargetResolver
): InstanceView | undefined {
  const current = resolve === undefined ? instance : refreshLive(instance, resolve)
  if (!mayRead(actor, current, context)) return undefined
  const step = stepOf(context.definition, current.currentStep)
  let visible: readonly string[] = []
  let editable: readonly string[] = []
  let required: readonly string[] = []
  let collapsed: readonly string[] = []
  let fields: readonly InstanceViewField[] = []
  let outcomes: readonly string[] = []
  if (step !== undefined) {
    const state = evaluateRules(step, current.values ?? {}, actor)
    visible = fieldKeys(step).filter(
      (key) => state.fields[key].visible && !state.fields[key].skipped
    )
    editable = editableKeys(actor, current, step).filter((key) => !state.fields[key].locked)
    required = fieldKeys(step).filter((key) => state.fields[key].required)
    collapsed = (step.sections ?? [])
      .filter((section) => state.sections[section.key].collapsed)
      .map((section) => section.key)
    fields = fieldsOf(step)
      .filter((field) => visible.includes(field.key))
      .map((field) => ({
        key: field.key,
        control: field.control,
        ...(field.label === undefined ? {} : { label: field.label }),
        ...(field.options === undefined ? {} : { options: [...field.options] }),
      }))
    outcomes = step.outcomes ?? []
  }
  return {
    instanceId: current.instanceId,
    status: status(current, context.definition, context.log),
    visible,
    editable,
    required,
    collapsed,
    values: restrict(current.values, visible),
    fields,
    outcomes,
    version: current.version ?? 0,
  }
}

/**
 * Re-resolve the live targets of an instance through the caller's resolver
 * (AS-4): a group or a team is read again, while a dynamic target keeps the
 * members the instance recorded (I13). The read's resolver is the engine's
 * injected directory seam (I6); `refreshAssignees` (resolve.ts) is the same
 * refresh over a raw membership.
 */
function refreshLive(instance: ProjectedInstance, resolve: TargetResolver): ProjectedInstance {
  return {
    ...instance,
    assignees: instance.assignees.map((assignee) =>
      isLiveTarget(assignee.target) ? { ...assignee, members: resolve(assignee.target) } : assignee
    ),
  }
}

/** The instance that a start event records (#187, I13), before any later event. */
function started(event: Event, instanceId: string): ProjectedInstance {
  const payload = event.payload
  return {
    instanceId,
    flow: stringField(payload, 'flow'),
    definitionVersion: stringField(payload, 'definitionVersion'),
    assignees: readAssignees(payload.assignees),
    connectorCalls: [],
    values: readValues(payload.values),
    starter: optionalString(payload.starter),
    currentStep: optionalString(payload.currentStep),
    submitted: false,
    version: 0,
  }
}

/**
 * Fold one later event of the instance into its state (#76, I4). Only the event
 * types that act on an instance appear on the filtered log, and the fold
 * mirrors the state transition that the write path recorded, so the projection
 * and the write path cannot disagree.
 */
function fold(
  instance: ProjectedInstance,
  event: Event,
  definition: FlowDefinition
): ProjectedInstance {
  switch (event.type) {
    case INSTANCE_SUBMITTED: {
      const values = readValues(event.payload.values)
      // A submit records a state change but keeps the version counter, because
      // `submitInstance` does not advance it (FM-7, I5).
      return { ...instance, submitted: true, ...(values === undefined ? {} : { values }) }
    }
    case STEP_CLAIMED:
      return advanced({ ...instance, holder: optionalString(event.payload.holder) })
    case STEP_COMPLETED: {
      const next = nextStep(definition, stringField(event.payload, 'step'))
      const entered = optionalAssignees(event.payload.assignees)
      const moved: ProjectedInstance = advanced({
        ...instance,
        holder: undefined,
        currentStep: next?.key,
        done: next === undefined,
      })
      return entered === undefined ? moved : recordAssignees(moved, entered)
    }
    case STEP_TAKEN_OVER:
      return advanced({ ...instance, holder: optionalString(event.payload.to) })
    case STEP_SENT_BACK:
      return advanced(sentBack(instance, event))
    case INSTANCE_WITHDRAWN:
      return advanced(closed(instance, event, 'withdrawn'))
    case INSTANCE_CANCELLED:
      return advanced(closed(instance, event, 'cancelled'))
    case INSTANCE_UNDONE:
      return advanced(reopened(instance, event))
    default:
      return instance
  }
}

/**
 * The instance after one accepted action (I5, #191): the version counter
 * advances by one, exactly as every write-path action advances it (`version +
 * 1`). A submit is the one state change that does not advance it, so the
 * fold leaves it out.
 */
function advanced(instance: ProjectedInstance): ProjectedInstance {
  return { ...instance, version: (instance.version ?? 0) + 1 }
}

/** Fold a send back: the instance revisits the target step, and it records the next revision (WF-3). */
function sentBack(instance: ProjectedInstance, event: Event): ProjectedInstance {
  const to = stringField(event.payload, 'to')
  const revisions = { ...(instance.revisions ?? {}) }
  const revision = event.payload.revision
  if (typeof revision === 'number') revisions[to] = revision
  const entered = optionalAssignees(event.payload.assignees)
  const moved: ProjectedInstance = { ...instance, currentStep: to, holder: undefined, revisions }
  return entered === undefined ? moved : recordAssignees(moved, entered)
}

/** Fold a withdraw or a cancel: it closes the task and records what the undo restores (WF-4, WF-5). */
function closed(
  instance: ProjectedInstance,
  event: Event,
  kind: 'withdrawn' | 'cancelled'
): ProjectedInstance {
  return {
    ...instance,
    currentStep: undefined,
    holder: undefined,
    withdrawal: kind,
    previousStep: optionalString(event.payload.step),
    previousHolder: optionalString(event.payload.holder),
    closedAt: event.at,
    closedBy: event.actor,
  }
}

/** Fold the undo of a withdraw or a cancel: it restores the previous step and holder (WF-5, I4). */
function reopened(instance: ProjectedInstance, event: Event): ProjectedInstance {
  return {
    ...instance,
    currentStep: optionalString(event.payload.step),
    holder: optionalString(event.payload.holder),
    withdrawal: undefined,
    previousStep: undefined,
    previousHolder: undefined,
    closedAt: undefined,
    closedBy: undefined,
  }
}

/** The step of the definition that the instance is on (WF-1); absent when no step is open. */
function stepOf(definition: FlowDefinition, key: string | undefined): FlowStep | undefined {
  if (key === undefined) return undefined
  return definition.steps.find((step) => step.key === key)
}

/** Every field key of a step in definition order (FM-1): its flat fields or its sections' fields. */
function fieldKeys(step: FlowStep): readonly string[] {
  if (step.fields !== undefined) return step.fields.map((field) => field.key)
  return (step.sections ?? []).flatMap((section) => section.fields.map((field) => field.key))
}

/**
 * The values that the instance holds, restricted to a set of field keys (FM-3).
 * A key the step does not make visible is absent from the result, so a field
 * the step hides never leaves the engine (I8).
 */
function restrict(
  values: Readonly<Record<string, JsonValue>> | undefined,
  keys: readonly string[]
): Readonly<Record<string, JsonValue>> {
  const restricted: Record<string, JsonValue> = {}
  if (values === undefined) return restricted
  for (const key of keys) {
    if (Object.hasOwn(values, key)) restricted[key] = values[key]
  }
  return restricted
}

/** Read the assignees that a start recorded (I13); an absent or malformed list is empty. */
function readAssignees(value: unknown): readonly Assignee[] {
  return Array.isArray(value) ? (value as readonly Assignee[]) : []
}

/**
 * Read the assignees that a transition recorded (I13); undefined when the event
 * carries none, so the fold keeps the step's earlier resolution rather than
 * inventing one.
 */
function optionalAssignees(value: unknown): readonly Assignee[] | undefined {
  return value === undefined ? undefined : readAssignees(value)
}

/** Read a values record (FM-7); an absent or malformed value is undefined. */
function readValues(value: unknown): Readonly<Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, JsonValue>>
}

/** Read a required string field of a payload. */
function stringField(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string') {
    throw new Error(`instance: the ${key} of an instance event must be a string (I4)`)
  }
  return value
}

/** Read an optional string field of a payload; a value of another type is absent. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
