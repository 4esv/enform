// Issue #76, FM-3, FM-7, VT-4, S14, DF-2, DX-1, I4, I6, I8, A9: the read half
// of FM-3, the instance as a step sees it, through the public API. #187 put an
// instance id on the log; these functions read it back. #177 wrote the values
// that a form holds; this closes FM-7's "the values are read back through the
// public API only".
//
// The projection folds the events whose payload names one instance, in log
// order, into that instance (I4). Events of another instance never affect the
// result: the fold filters by the instance id before it reads anything else.
// The step-scoped read then narrows the instance to the actor and to the
// current step: the fields the step does not make visible are absent (FM-3),
// the fields it makes editable are editable only for an assignee, and the
// actor must be allowed to read the instance at all (I8). Every function is
// pure and deterministic (I6): it reads no clock, no random source and no I/O.

import { nextStep, STEP_CLAIMED, STEP_COMPLETED } from './action.js'
import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'
import { publishedByHash } from './flow.js'
import type { Assignee, Instance } from './instance.js'
import type { ActorId, Event, Log } from './operation.js'
import type { TargetResolver } from './routing.js'
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
export type ProjectedInstance = Instance & { readonly instanceId: string }

/**
 * The instance as one actor and one step see it (#76, FM-3, FM-7, VT-4, I8).
 * `visible` is the field keys the current step shows, in definition order,
 * `editable` is the field keys the actor may change (empty for one that may
 * read but is not an assignee of the step), and `values` holds only the field
 * keys the step makes visible, so a field the step hides is absent from the
 * response (FM-3 criterion 1).
 */
export type InstanceView = {
  /** The id of the instance the view describes (DX-1, #187). */
  readonly instanceId: string
  /** The status line of the instance (VT-1, VT-2, S14), reused from status.ts. */
  readonly status: Status
  /** The field keys the current step makes visible, in definition order (FM-3). */
  readonly visible: readonly string[]
  /** The field keys the actor may edit on the current step (FM-3); empty when the actor is not an assignee. */
  readonly editable: readonly string[]
  /** The values the instance holds, restricted to the visible field keys (FM-3, FM-7). */
  readonly values: Readonly<Record<string, JsonValue>>
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
 * Read the instance as one actor and the current step see it (#76, FM-3, FM-7,
 * VT-4, I8). The engine authorizes the read with the same rule as a status read
 * (mayRead): the starter, an assignee, or a principal that holds
 * `instance.read` on the flow. An actor that may not read the instance answers
 * undefined, which the API serves as 403. The view then holds the visible and
 * editable field keys of the current step and the values restricted to the
 * visible keys. It is pure and deterministic (I6); it reads no clock, no random
 * source and no I/O.
 */
export function readInstance(
  actor: ActorId,
  instance: ProjectedInstance,
  context: StatusContext,
  _refresh?: TargetResolver
): InstanceView | undefined {
  if (!mayRead(actor, instance, context)) return undefined
  const step = stepOf(context.definition, instance.currentStep)
  const visible = step === undefined ? [] : visibleKeys(step)
  const editable = step === undefined ? [] : editableKeys(actor, instance, step)
  return {
    instanceId: instance.instanceId,
    status: status(instance, context.definition, context.log),
    visible,
    editable,
    values: restrict(instance.values, visible),
  }
}

/** The instance that a start event records (#187, I13), before any later event. */
function started(event: Event, instanceId: string): ProjectedInstance {
  const payload = event.payload
  return {
    instanceId,
    definitionVersion: stringField(payload, 'definitionVersion'),
    assignees: readAssignees(payload.assignees),
    connectorCalls: [],
    values: readValues(payload.values),
    starter: optionalString(payload.starter),
    currentStep: optionalString(payload.currentStep),
    submitted: false,
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
      return { ...instance, submitted: true, ...(values === undefined ? {} : { values }) }
    }
    case STEP_CLAIMED:
      return { ...instance, holder: optionalString(event.payload.holder) }
    case STEP_COMPLETED: {
      const next = nextStep(definition, stringField(event.payload, 'step'))
      return { ...instance, holder: undefined, currentStep: next?.key, done: next === undefined }
    }
    case STEP_TAKEN_OVER:
      return { ...instance, holder: optionalString(event.payload.to) }
    case STEP_SENT_BACK:
      return sentBack(instance, event)
    case INSTANCE_WITHDRAWN:
      return closed(instance, event, 'withdrawn')
    case INSTANCE_CANCELLED:
      return closed(instance, event, 'cancelled')
    case INSTANCE_UNDONE:
      return reopened(instance, event)
    default:
      return instance
  }
}

/** Fold a send back: the instance revisits the target step, and it records the next revision (WF-3). */
function sentBack(instance: ProjectedInstance, event: Event): ProjectedInstance {
  const to = stringField(event.payload, 'to')
  const revisions = { ...(instance.revisions ?? {}) }
  const revision = event.payload.revision
  if (typeof revision === 'number') revisions[to] = revision
  return { ...instance, currentStep: to, holder: undefined, revisions }
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

/** The field keys a step makes visible (FM-3): its `visible`, or every field when it declares none. */
function visibleKeys(step: FlowStep): readonly string[] {
  return step.visible ?? fieldKeys(step)
}

/** Every field key of a step in definition order (FM-1): its flat fields or its sections' fields. */
function fieldKeys(step: FlowStep): readonly string[] {
  if (step.fields !== undefined) return step.fields.map((field) => field.key)
  return (step.sections ?? []).flatMap((section) => section.fields.map((field) => field.key))
}

/**
 * The field keys the actor may edit on the step (FM-3). A step that declares no
 * `editable` makes no field editable, and only an assignee of the current step
 * gets the editable keys; an actor that may read but is not an assignee gets an
 * empty list.
 */
function editableKeys(
  actor: ActorId,
  instance: ProjectedInstance,
  step: FlowStep
): readonly string[] {
  if (step.editable === undefined) return []
  if (!isStepAssignee(actor, instance, step.key)) return []
  return step.editable
}

/** Whether the actor is an assignee of one step (AS-2, AS-4). */
function isStepAssignee(actor: ActorId, instance: ProjectedInstance, step: string): boolean {
  return instance.assignees.some(
    (assignee) => assignee.step === step && assignee.members.includes(actor)
  )
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
