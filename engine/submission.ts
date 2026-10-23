// Issue #43, #177, S06, ID-2, AC-1, I2, I6, I10, I13, I14, SE-1, FM-7:
// start and submit a submission.
// Issue #76, DX-1, #187: a start and a submit name the instance they act on.
// Issue #192, WF-1, S05, I4: a start records the steps its route skipped.
//
// S06: Sam opens a form link, fills it in and submits it. The engine never
// creates an anonymous draft (ID-2): a start needs a signed-in principal, and
// only the engine decides whether that principal may start (AC-1, I8), through
// the grants that apply to it. A start routes the draft to the assignees of the
// first step whose skip condition is false (WF-1, I10), records the steps that
// its route skipped with the conditions on the instance.started@1 event, and
// stamps the instance with its definition version and those assignees (DF-2,
// I13). Both a start and a submit record the values that the form holds (FM-7):
// the start records the values that it routed with, and the submit records the
// values that the step captured, merged over what the instance already held. A
// submit marks the instance submitted and, in the same operation, records the
// assignment email that the first assignee receives (I2, SE-1): one apply
// commits the state change and its side effect together, and a worker delivers
// it later. Both functions are pure and deterministic (I6): they read no clock,
// no random source and no I/O, and the injected sources come in as arguments.

import { authorize, type Grant } from './authorize.js'
import type { ConditionData } from './condition.js'
import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'
import { type Flow, publishedFlow } from './flow.js'
import { createInstance, type Instance } from './instance.js'
import {
  type ActorId,
  createOperation,
  type Log,
  type Operation,
  type OperationDeps,
  type OperationId,
} from './operation.js'
import { createOutboxOperation, type OutboxEntry } from './outbox.js'
import { resolveAssignees, type TargetResolver } from './routing.js'
import { isStepSkipped, type SkippedStep } from './workflow.js'

/**
 * The versioned event type of a start (S06, MVP.md 9.1, #192). The start
 * records the steps that its route skipped, with the conditions that skipped
 * them, so a read attributes every skip to this instance (WF-1, S05).
 */
export const INSTANCE_STARTED = 'instance.started@1'

/** The versioned event type of a submit (S06, MVP.md 9.1). */
export const INSTANCE_SUBMITTED = 'instance.submitted@1'

/** The connector operation that sends the assignment email (SE-1, SE-2: task assigned). */
export const ASSIGNMENT_EMAIL = 'send-assignment'

/** The connector that delivers email (SE-1). */
export const EMAIL_CONNECTOR = 'connector-smtp'

/** The result of a start: the draft instance and the operation that recorded it (S06, I14). */
export type StartedInstance = {
  readonly instance: Instance
  readonly operation: Operation
}

/** The result of a submit: the submitted instance and the operation that recorded it (S06, I2). */
export type SubmittedInstance = {
  readonly instance: Instance
  readonly operation: Operation
}

/**
 * Start a submission (S06, ID-2, AC-1, DF-2, DX-1, I10, I13, FM-7). A start
 * needs a signed-in principal (ID-2), and when `grants` are given the acting
 * principal must hold `instance.start` on `flow:<slug>` (AC-1, I8); the caller
 * passes its own grants and those of the groups and the teams that it belongs
 * to, as `grantsOf` reads them from the log. The client mints the instance id
 * that `instanceId` carries, as it mints the operation id (ADR 0004), and the
 * start records it on the instance and in the `instance.started@1` payload, so
 * the log names the instance that the event started (#187), and records the slug
 * of the flow it runs (#222, I4). The function routes the draft to the
 * assignees of the first step whose skip condition is false
 * (WF-1, I10), records the steps that its route skipped with the conditions on
 * the start event, attributed to the starter (#192, S05), stamps the instance
 * with the content hash of the flow's latest published version (DF-2, I13), and
 * records the values that it routed with (FM-7). It is pure and deterministic
 * (I6).
 */
export function startInstance(
  flow: Flow,
  instanceId: string,
  data: ConditionData,
  actor: ActorId | undefined,
  deps: OperationDeps,
  resolve: TargetResolver,
  grants?: readonly Grant[]
): StartedInstance {
  const resource = `flow:${flow.slug}`
  assertStartable(actor, grants, resource)
  const definition = startableDefinition(flow)
  const route = routeAtStart(definition, data)
  const assignees = resolveAssignees(route.step, resolve)
  const instance: Instance = {
    ...createInstance(definition, assignees),
    instanceId,
    currentStep: route.step.key,
    submitted: false,
    starter: actor,
    values: data,
  }
  const change = {
    instanceId,
    // The flow slug names the flow the instance runs (#222, I4). Two flows with
    // identical definitions hash the same, so the slug is what tells their
    // instances apart.
    flow: flow.slug,
    definitionVersion: instance.definitionVersion,
    currentStep: route.step.key,
    assignees,
    starter: actor,
    values: data,
    skipped: route.skipped,
  }
  const operation = createOperation(INSTANCE_STARTED, change, deps, actor)
  return { instance, operation }
}

/**
 * The client intent for a start (ADR 0010): the pieces a browser honestly
 * knows. It carries the ID the client chose (I1), the time it read (I6), the
 * principal it acts as (ID-2), the flow slug, the instance id it minted
 * (DX-1, #187), and the values it collected (FM-7). Everything else is the
 * engine's to resolve.
 */
export type StartIntent = {
  readonly id: OperationId
  readonly type: typeof INSTANCE_STARTED
  readonly at: number
  readonly actor: ActorId
  readonly payload: {
    readonly flow: string
    readonly instanceId: string
    readonly values: ConditionData
  }
}

/**
 * Resolve a client intent into the operation the engine records (ADR 0010,
 * DX-1, A9, WF-1, I13, DF-2, FM-7). A start intent names a flow, the instance
 * id it minted and the values it collected; the engine reads the flow's newest
 * published version from the log (DF-2) and runs the same `startInstance` path
 * that the api-mode runner uses, so the route (WF-1), the assignees (I13), the
 * version stamp, the starter and the values (FM-7) are all engine decisions.
 * The client's ID, time and instance id survive because they are the injected
 * sources (I1, I6): the function reads no clock and no random source of its
 * own.
 *
 * It answers `undefined` when `value` is not a start intent, so an already
 * resolved operation keeps the low-level append path. A value shaped as a
 * start intent but unresolvable throws a named error, and an intent that names
 * a flow but no instance id is refused by shape rather than appended as a raw
 * operation (#187).
 */
export function resolveIntent(
  log: Log,
  value: unknown,
  resolve: TargetResolver,
  grants?: readonly Grant[]
): Operation | undefined {
  const intent = asStartIntent(value)
  if (intent === undefined) return undefined
  const version = publishedFlow(log, intent.payload.flow)
  if (version === undefined) {
    throw new Error(
      `intent: the flow ${intent.payload.flow} has no published version to start on (DF-2)`
    )
  }
  const flow: Flow = { slug: intent.payload.flow, versions: [version] }
  return startInstance(
    flow,
    intent.payload.instanceId,
    intent.payload.values,
    intent.actor,
    { clock: () => intent.at, ids: () => intent.id },
    resolve,
    grants
  ).operation
}

/**
 * Read a start intent from an unknown value, or undefined when it is not one
 * (ADR 0010). A resolved start carries `definitionVersion`; an intent names
 * `flow` and the instance id it minted. The detector answers by that shape, so
 * the resolved operation keeps the low-level append path.
 */
function asStartIntent(value: unknown): StartIntent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.type !== INSTANCE_STARTED) return undefined
  const payload = candidate.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const change = payload as Record<string, unknown>
  // A resolved start now names its flow too (#222), so the detector tells the
  // two apart by the definition version that only the engine's operation has.
  if ('definitionVersion' in change) return undefined
  if (typeof change.flow !== 'string') return undefined
  if (typeof change.instanceId !== 'string') {
    throw new Error('intent: the instanceId must be a string (DX-1)')
  }
  if (typeof candidate.id !== 'string') throw new Error('intent: the id must be a string (I1)')
  if (typeof candidate.at !== 'number') throw new Error('intent: the at must be a number (I6)')
  if (typeof candidate.actor !== 'string') {
    throw new Error('intent: the actor must name a principal (ID-2)')
  }
  const values = change.values
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('intent: the values must be an object (FM-7)')
  }
  return {
    id: candidate.id,
    type: INSTANCE_STARTED,
    at: candidate.at,
    actor: candidate.actor,
    payload: { flow: change.flow, instanceId: change.instanceId, values: values as ConditionData },
  }
}

/**
 * Submit a submission (S06, I2, SE-1, FM-7, DX-1). The instance becomes
 * submitted, and one operation records the instance it acts on (#76, #187),
 * the mark, the values that the step captured merged over what the instance
 * already held (FM-7), and the assignment email that the first assignee
 * receives, so one apply commits the state change and its side effect together
 * (I2). The event type stays `instance.submitted@1`: no release tag exists, so
 * the shape extends in place (MVP.md 9.3, #188). The engine records the email;
 * a worker delivers it later (SE-1). The function is pure and deterministic
 * (I6).
 */
export function submitInstance(
  instance: Instance,
  actor: ActorId,
  deps: OperationDeps,
  values: Readonly<Record<string, JsonValue>>
): SubmittedInstance {
  const merged = mergeValues(instance.values, values)
  const submitted: Instance = { ...instance, submitted: true, values: merged }
  const change = {
    instanceId: instance.instanceId,
    currentStep: instance.currentStep,
    submitted: true,
    values: merged,
  }
  const operation = createOutboxOperation(
    INSTANCE_SUBMITTED,
    change,
    [assignmentEmail(instance)],
    deps,
    actor
  )
  return { instance: submitted, operation }
}

/**
 * The values that a submit records (FM-7): the values that the step captured,
 * merged over what the instance already held. The captured value wins for a key
 * that the step set again.
 */
function mergeValues(
  held: Readonly<Record<string, JsonValue>> | undefined,
  captured: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, JsonValue>> {
  return { ...held, ...captured }
}

/**
 * Authorize a start (ID-2, AC-1, I8). A start without a principal is refused:
 * the engine never creates an anonymous draft (ID-2). When the caller gives
 * the acting principal's grants, the principal must hold `instance.start` on
 * the flow (AC-1). The check narrows the actor, so the caller's start has a
 * principal.
 */
function assertStartable(
  actor: ActorId | undefined,
  grants: readonly Grant[] | undefined,
  resource: string
): asserts actor is ActorId {
  if (actor === undefined) {
    throw new Error('instance: a start requires a signed-in principal (ID-2)')
  }
  if (grants !== undefined && !authorize(grants, 'instance.start', resource)) {
    throw new Error(`instance: starting ${resource} requires the scope instance.start (AC-1)`)
  }
}

/**
 * The definition that a start pins the instance to (DF-2, I13): the flow's
 * latest published version. A flow with no published version cannot start.
 */
function startableDefinition(flow: Flow): FlowDefinition {
  const latest = flow.versions.at(-1)
  if (latest === undefined) {
    throw new Error(`instance: the flow ${flow.slug} has no published version to start on (DF-2)`)
  }
  return latest.definition
}

/**
 * The route that the draft takes at a start (WF-1, S05, #192): the first step
 * whose skip condition is false, and the steps before it that the route
 * skipped, in definition order, with the condition that skipped each. A step
 * with no condition is never skipped. Every step being skipped is a flow
 * error, and the start refuses rather than routing nowhere.
 */
function routeAtStart(
  definition: FlowDefinition,
  data: ConditionData
): { readonly step: FlowStep; readonly skipped: readonly SkippedStep[] } {
  const skipped: SkippedStep[] = []
  for (const step of definition.steps) {
    if (step.skipWhen !== undefined && isStepSkipped(step, data)) {
      skipped.push({ step: step.key, condition: step.skipWhen })
      continue
    }
    return { step, skipped }
  }
  throw new Error('instance: every step is skipped, so the start has no step to route (WF-1)')
}

/**
 * The assignment email that the first assignee of the current step receives
 * (S06, SE-1): the connector operation, the connector and the recipient. The
 * instance accumulates the assignees of every step it entered, so the
 * recipient is the first member of the current step and not the first member
 * of an earlier step. A log that records no assignee for the current step
 * falls back to the first recorded member, so an instance from before every
 * entered step carried its assignees still records an email. I10 forbids a
 * silent drop, so a step whose assignees resolve to nobody refuses the submit
 * rather than record no email.
 */
function assignmentEmail(instance: Instance): OutboxEntry {
  const current = instance.assignees.find((assignee) => assignee.step === instance.currentStep)
    ?.members[0]
  const to = current ?? instance.assignees.flatMap((assignee) => assignee.members)[0]
  if (to === undefined) {
    throw new Error(`instance: the step ${instance.currentStep} has no assignee to notify (I10)`)
  }
  const payload = { to, step: instance.currentStep }
  return { operation: ASSIGNMENT_EMAIL, target: EMAIL_CONNECTOR, payload }
}
