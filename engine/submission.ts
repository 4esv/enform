// Issue #43, #177, S06, ID-2, AC-1, I2, I6, I10, I13, I14, SE-1, FM-7:
// start and submit a submission.
//
// S06: Sam opens a form link, fills it in and submits it. The engine never
// creates an anonymous draft (ID-2): a start needs a signed-in principal, and
// only the engine decides whether that principal may start (AC-1, I8), through
// the grants that apply to it. A start routes the draft to the assignees of the
// first step whose skip condition is false (WF-1, I10) and stamps the instance
// with its definition version and those assignees (DF-2, I13). Both a start
// and a submit record the values that the form holds (FM-7): the start records
// the values that it routed with, and the submit records the values that the
// step captured, merged over what the instance already held. A submit marks
// the instance submitted and, in the same operation, records the assignment
// email that the first assignee receives (I2, SE-1): one apply commits the
// state change and its side effect together, and a worker delivers it later.
// Both functions are pure and deterministic (I6): they read no clock, no
// random source and no I/O, and the injected sources come in as arguments.

import { authorize, type Grant } from './authorize.js'
import type { ConditionData } from './condition.js'
import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'
import type { Flow } from './flow.js'
import { createInstance, type Instance } from './instance.js'
import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'
import { createOutboxOperation, type OutboxEntry } from './outbox.js'
import { resolveAssignees, type TargetResolver } from './routing.js'
import { isStepSkipped } from './workflow.js'

/** The versioned event type of a start (S06, MVP.md 9.1). */
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
 * Start a submission (S06, ID-2, AC-1, DF-2, I10, I13, FM-7). A start needs a
 * signed-in principal (ID-2), and when `grants` are given the acting principal
 * must hold `instance.start` on `flow:<slug>` (AC-1, I8); the caller passes its
 * own grants and those of the groups and the teams that it belongs to, as
 * `grantsOf` reads them from the log. The function routes the draft to the
 * assignees of the first step whose skip condition is false (WF-1, I10), stamps
 * the instance with the content hash of the flow's latest published version
 * (DF-2, I13), and records the values that it routed with (FM-7). It is pure
 * and deterministic (I6).
 */
export function startInstance(
  flow: Flow,
  data: ConditionData,
  actor: ActorId | undefined,
  deps: OperationDeps,
  resolve: TargetResolver,
  grants?: readonly Grant[]
): StartedInstance {
  const resource = `flow:${flow.slug}`
  assertStartable(actor, grants, resource)
  const definition = startableDefinition(flow)
  const step = firstActiveStep(definition, data)
  const assignees = resolveAssignees(step, resolve)
  const instance: Instance = {
    ...createInstance(definition, assignees),
    currentStep: step.key,
    submitted: false,
    starter: actor,
    values: data,
  }
  const change = {
    definitionVersion: instance.definitionVersion,
    currentStep: step.key,
    assignees,
    starter: actor,
    values: data,
  }
  const operation = createOperation(INSTANCE_STARTED, change, deps, actor)
  return { instance, operation }
}

/**
 * Submit a submission (S06, I2, SE-1, FM-7). The instance becomes submitted,
 * and one operation records the mark, the values that the step captured merged
 * over what the instance already held (FM-7), and the assignment email that the
 * first assignee receives, so one apply commits the state change and its side
 * effect together (I2). The engine records the email; a worker delivers it
 * later (SE-1). The function is pure and deterministic (I6).
 */
export function submitInstance(
  instance: Instance,
  actor: ActorId,
  deps: OperationDeps,
  values: Readonly<Record<string, JsonValue>>
): SubmittedInstance {
  const merged = mergeValues(instance.values, values)
  const submitted: Instance = { ...instance, submitted: true, values: merged }
  const change = { currentStep: instance.currentStep, submitted: true, values: merged }
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
 * The step that the draft routes to (WF-1, S06): the first step whose skip
 * condition is false. A step with no condition is never skipped. Every step
 * being skipped is a flow error, and the start refuses rather than routing
 * nowhere.
 */
function firstActiveStep(definition: FlowDefinition, data: ConditionData): FlowStep {
  const step = definition.steps.find((candidate) => !isStepSkipped(candidate, data))
  if (step === undefined) {
    throw new Error('instance: every step is skipped, so the start has no step to route (WF-1)')
  }
  return step
}

/**
 * The assignment email that the first assignee receives (S06, SE-1): the
 * connector operation, the connector and the recipient. I10 forbids a silent
 * drop, so a step whose assignees resolve to nobody refuses the submit rather
 * than record no email.
 */
function assignmentEmail(instance: Instance): OutboxEntry {
  const to = instance.assignees.flatMap((assignee) => assignee.members)[0]
  if (to === undefined) {
    throw new Error(`instance: the step ${instance.currentStep} has no assignee to notify (I10)`)
  }
  const payload = { to, step: instance.currentStep }
  return { operation: ASSIGNMENT_EMAIL, target: EMAIL_CONNECTOR, payload }
}
