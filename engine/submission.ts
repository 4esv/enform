// Issue #43, #177, S06, ID-2, AC-1, I2, I6, I10, I13, I14, SE-1, FM-7:
// start and submit a submission.
// Issue #76, DX-1, #187: a start and a submit name the instance they act on.
// Issue #192, WF-1, S05, I4: a submit records the steps its route skipped.
// Issue #256, ADR 0014, FM-4, VT-4, D1, SE-2: a start is a private draft on
// the request form, the starter edits it, and the submit validates the form,
// routes it and notifies the assignees.
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

import { validateStep } from './action.js'
import { authorize, type Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { ConditionData } from './condition.js'
import { type FlowDefinition, type FlowStep, fieldsOf, type JsonValue } from './definition.js'
import type { FieldError } from './fields.js'
import { type Flow, publishedByHash, publishedFlow } from './flow.js'
import { type Assignee, createInstance, type Instance, recordAssignees } from './instance.js'
import { instanceOf } from './instances.js'
import {
  type ActorId,
  createOperation,
  type Log,
  type Operation,
  type OperationDeps,
  type OperationId,
} from './operation.js'
import { createOutboxOperation, type OutboxEntry } from './outbox.js'
import { route, type TargetResolver } from './routing.js'
import { routeAfter } from './workflow.js'

/**
 * The versioned event type of a start (S06, MVP.md 9.1, #192). The start
 * records the steps that its route skipped, with the conditions that skipped
 * them, so a read attributes every skip to this instance (WF-1, S05).
 */
export const INSTANCE_STARTED = 'instance.started@1'

/** The versioned event type of a submit (S06, MVP.md 9.1, ADR 0014). */
export const INSTANCE_SUBMITTED = 'instance.submitted@1'

/** The versioned event type of a draft edit (RT-3, ADR 0014): the starter changes the values a draft holds. */
export const DRAFT_EDITED = 'draft.edited@1'

/** The connector operation that sends the assignment email (SE-1, SE-2: task assigned). */
export const ASSIGNMENT_EMAIL = 'send-assignment'

/** The connector that delivers email (SE-1). */
export const EMAIL_CONNECTOR = 'connector-smtp'

/** The result of a start: the draft instance and the operation that recorded it (S06, I14). */
export type StartedInstance = {
  readonly instance: Instance
  readonly operation: Operation
}

/**
 * The result of a draft edit or a submit (ADR 0014, I5, FM-4). `accepted`
 * says whether the engine applied the change. When it did not, the instance
 * is unchanged, `operation` is absent and `reason` says why: the actor is not
 * the starter, the instance is no draft, the view is stale, a captured key is
 * not on the request form, or a value fails its control; a validation refusal
 * names every error by field path in `errors` (FM-4).
 */
export type SubmitResult = {
  readonly accepted: boolean
  readonly instance: Instance
  readonly operation?: Operation
  readonly reason?: string
  readonly errors?: readonly FieldError[]
}

/**
 * What a submit needs beside the draft (ADR 0014): the flow slug, the
 * definition the draft is pinned to, the directory resolver that routes the
 * next step (AS-1, AS-4), the grants that apply to the starter, and the flow
 * owner that an unroutable step alerts (I10).
 */
export type SubmitContext = {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly resolve: TargetResolver
  readonly grants?: readonly Grant[]
  readonly owner?: ActorId
}

/**
 * Start a submission (S06, ID-2, AC-1, DF-2, DX-1, I10, I13, FM-7). A start
 * needs a signed-in principal (ID-2), and when `grants` are given the acting
 * principal must hold `instance.start` on `flow:<slug>` (AC-1, I8); the caller
 * passes its own grants and those of the groups and the teams that it belongs
 * to, as `grantsOf` reads them from the log. When `owner` is given it names
 * the flow owner that an unroutable start alerts (I10); an absent owner is the
 * starter, so no alert is ever lost. The client mints the instance id
 * that `instanceId` carries, as it mints the operation id (ADR 0004), and the
 * start records it on the instance and in the `instance.started@1` payload, so
 * the log names the instance that the event started (#187), and records the slug
 * of the flow it runs (#222, I4). The function routes the draft to the
 * assignees of the first step whose skip condition is false
 * (WF-1, I10), or to the Unroutable queue with the owner alert when every
 * target resolves to nobody (I10, AS-5), records the steps that its route
 * skipped with the conditions on the start event, attributed to the starter
 * (#192, S05), stamps the instance
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
  grants?: readonly Grant[],
  owner?: ActorId
): StartedInstance {
  const resource = `flow:${flow.slug}`
  assertStartable(actor, grants, resource)
  const definition = startableDefinition(flow)
  const request = requestStep(definition)
  // ADR 0014: the draft sits on the request form, the first step, and routes
  // nothing yet; the starter is its only assignee, so the starter alone edits
  // it. `resolve` and `owner` route the submit, not the start.
  void resolve
  void owner
  const assignees: readonly Assignee[] = [
    { step: request.key, target: { starter: 'starter' }, members: [actor] },
  ]
  const instance: Instance = {
    ...createInstance(definition, assignees),
    instanceId,
    currentStep: request.key,
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
    currentStep: request.key,
    assignees,
    starter: actor,
    values: data,
    skipped: [],
  }
  return { instance, operation: createOperation(INSTANCE_STARTED, change, deps, actor) }
}

/**
 * Edit a draft (ADR 0014, RT-3, D1, I1): the starter changes the values the
 * draft holds, as one idempotent operation per edit, so a browser can send
 * each edit with the id it chose and a retry appends nothing. The values merge
 * over what the draft holds; the submit validates them (FM-4), so an edit is
 * never refused for its content. Only the starter edits a draft, and only
 * while it is one: a submitted instance changes through its steps.
 */
export function editDraft(
  instance: Instance,
  actor: ActorId,
  values: Readonly<Record<string, JsonValue>>,
  deps: OperationDeps
): SubmitResult {
  const refusal = draftRefusal(instance, actor, 'edit')
  if (refusal !== undefined) return { accepted: false, instance, reason: refusal }
  const edited: Instance = { ...instance, values: mergeValues(instance.values, values) }
  const operation = createOperation(
    DRAFT_EDITED,
    { instanceId: instance.instanceId, values },
    deps,
    actor
  )
  return { accepted: true, instance: edited, operation }
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
  grants?: readonly Grant[],
  owner?: ActorId
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
    grants,
    owner
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
 * Submit a draft (S06, ADR 0014, FM-4, FM-7, WF-1, I2, I5, I13, SE-2, DX-1).
 * The submit is the starter's completion of the request form, the first step
 * of the definition. The engine refuses an actor that is not the starter, an
 * instance that is no draft and a stale view (I5), then runs the request
 * form's rules again over the values the submission creates and validates
 * every captured value against its control, refusing with every error named
 * by path (FM-4, A9); a captured key the form does not make editable is
 * refused by name (FM-3). On acceptance the request form is completed, the
 * instance routes to the next step whose skip condition is false, or to the
 * Unroutable queue with the owner alert (WF-1, I10), records the assignees,
 * the skipped steps with their conditions (S05) and the merged values (FM-7),
 * and carries the task-assigned email of every assignee in the same
 * operation (I2, SE-2). A flow whose only step is the request form is done at
 * the submit. The function is pure and deterministic (I6).
 */
export function submitInstance(
  instance: Instance,
  actor: ActorId,
  values: Readonly<Record<string, JsonValue>>,
  expectedVersion: Version,
  context: SubmitContext,
  deps: OperationDeps
): SubmitResult {
  const refusal = draftRefusal(instance, actor, 'submit')
  if (refusal !== undefined) return { accepted: false, instance, reason: refusal }
  const version = instance.version ?? 0
  if (expectedVersion !== version) {
    return { accepted: false, instance, reason: 'the view is stale, refresh and retry' }
  }
  const request = requestStep(context.definition)
  const checked = validateStep(request, actor, instance, values, requestEditable(request))
  if (checked.errors !== undefined) {
    return {
      accepted: false,
      instance,
      errors: checked.errors,
      reason: `step ${request.key}: ${checked.reason} (FM-4)`,
    }
  }
  if (checked.reason !== undefined) {
    return { accepted: false, instance, reason: `step ${request.key}: ${checked.reason}` }
  }
  // A skipped key is absent from the recorded capture (FM-2, FM-7).
  const kept = Object.fromEntries(checked.captured.map((key) => [key, values[key]]))
  const merged = mergeValues(instance.values, kept)
  const entry = routeAfter(context.definition, request.key, merged)
  const routed =
    entry.step === undefined
      ? undefined
      : route(entry.step, context.resolve, context.owner ?? actor)
  const assignees = routed?.assignees
  const advanced: Instance = {
    ...instance,
    submitted: true,
    values: merged,
    holder: undefined,
    currentStep: entry.step?.key,
    done: entry.step === undefined,
    version: version + 1,
    ...(routed?.queue === undefined ? {} : { queue: routed.queue }),
  }
  const submitted = assignees === undefined ? advanced : recordAssignees(advanced, assignees)
  const change = {
    instanceId: instance.instanceId,
    step: request.key,
    submitted: true,
    values: merged,
    skipped: entry.skipped,
    ...(entry.step === undefined ? { done: true } : { currentStep: entry.step.key }),
    ...(assignees === undefined ? {} : { assignees }),
    ...(routed?.queue === undefined ? {} : { queue: routed.queue }),
  }
  const outbox = [
    ...(assignees === undefined ? [] : assignmentEmails(assignees)),
    ...(routed?.alert === undefined ? [] : [routed.alert]),
  ]
  const operation =
    outbox.length === 0
      ? createOperation(INSTANCE_SUBMITTED, change, deps, actor)
      : createOutboxOperation(INSTANCE_SUBMITTED, change, outbox, deps, actor)
  return { accepted: true, instance: submitted, operation }
}

/**
 * The client intent for a submit (ADR 0010, ADR 0014): the instance, the
 * version the client read (I5) and the values the request form captured
 * (FM-7). The engine decides the validation, the route and the emails.
 */
export type SubmitIntent = {
  readonly id: OperationId
  readonly type: typeof INSTANCE_SUBMITTED
  readonly at: number
  readonly actor: ActorId
  readonly payload: {
    readonly instanceId: string
    readonly version: number
    readonly values: Readonly<Record<string, JsonValue>>
  }
}

/**
 * The engine refused a submit or a draft edit (FM-4, FM-3, I5, ADR 0014). The
 * server answers 409 with the reason and every validation error by path; an
 * actor that is not the starter is a 403.
 */
export class SubmitRefused extends Error {
  readonly errors: readonly FieldError[]
  readonly status: 403 | 409

  constructor(reason: string, errors: readonly FieldError[] = [], status: 403 | 409 = 409) {
    super(reason)
    this.errors = errors
    this.status = status
  }
}

/**
 * Resolve a submit intent into the operation the engine records (ADR 0010,
 * ADR 0014). The engine projects the draft from the log (I4), reads the
 * published definition it is pinned to (DF-2) and runs `submitInstance`, so
 * the validation, the route, the assignees and the emails are engine
 * decisions; the client's id and time survive as the injected sources (I1,
 * I6). It answers `undefined` when `value` is not a submit intent, so a
 * resolved operation keeps the raw append path, and throws `SubmitRefused`
 * when the engine refuses.
 */
export function resolveSubmitIntent(
  log: Log,
  value: unknown,
  resolve: TargetResolver,
  grants?: readonly Grant[],
  owner?: ActorId
): Operation | undefined {
  const intent = asSubmitIntent(value)
  if (intent === undefined) return undefined
  const instance = instanceOf(log, intent.payload.instanceId)
  if (instance === undefined) {
    throw new Error(`submit: the log holds no instance ${intent.payload.instanceId} (DX-1)`)
  }
  const published = publishedByHash(log, instance.definitionVersion)
  if (published === undefined) {
    throw new Error(`submit: the log holds no published definition for ${instance.instanceId}`)
  }
  const result = submitInstance(
    instance,
    intent.actor,
    intent.payload.values,
    intent.payload.version,
    { flow: instance.flow, definition: published.definition, resolve, grants, owner },
    { clock: () => intent.at, ids: () => intent.id }
  )
  if (!result.accepted || result.operation === undefined) {
    const reason = result.reason ?? 'the submit was refused'
    throw new SubmitRefused(reason, result.errors, reason.includes('starter') ? 403 : 409)
  }
  return result.operation
}

/**
 * Resolve a draft edit intent (ADR 0014, RT-3): the instance and the values
 * the starter changed. It answers `undefined` when `value` is not one and
 * throws `SubmitRefused` when the engine refuses.
 */
export function resolveDraftEditIntent(log: Log, value: unknown): Operation | undefined {
  if (!isRecord(value) || value.type !== DRAFT_EDITED) return undefined
  const payload = isRecord(value.payload) ? value.payload : {}
  if (typeof payload.instanceId !== 'string') {
    throw new Error('draft edit: the instanceId must be a string (DX-1)')
  }
  if (typeof value.id !== 'string') throw new Error('draft edit: the id must be a string (I1)')
  if (typeof value.at !== 'number') throw new Error('draft edit: the at must be a number (I6)')
  if (typeof value.actor !== 'string') {
    throw new Error('draft edit: the actor must name a principal (ID-2)')
  }
  if (!isRecord(payload.values)) throw new Error('draft edit: the values must be an object (FM-7)')
  const instance = instanceOf(log, payload.instanceId)
  if (instance === undefined) {
    throw new Error(`draft edit: the log holds no instance ${payload.instanceId} (DX-1)`)
  }
  const result = editDraft(instance, value.actor, payload.values as Record<string, JsonValue>, {
    clock: () => value.at as number,
    ids: () => value.id as string,
  })
  if (!result.accepted || result.operation === undefined) {
    const reason = result.reason ?? 'the edit was refused'
    throw new SubmitRefused(reason, [], reason.includes('starter') ? 403 : 409)
  }
  return result.operation
}

/** Read a submit intent from an unknown value, or undefined when it is not one (ADR 0010). */
function asSubmitIntent(value: unknown): SubmitIntent | undefined {
  if (!isRecord(value) || value.type !== INSTANCE_SUBMITTED) return undefined
  const payload = isRecord(value.payload) ? value.payload : {}
  // A resolved submit names the step it completed; an intent names the
  // version the client read (I5).
  if ('step' in payload || 'submitted' in payload) return undefined
  if (typeof payload.instanceId !== 'string') {
    throw new Error('submit: the instanceId must be a string (DX-1)')
  }
  if (typeof payload.version !== 'number' || !Number.isInteger(payload.version)) {
    throw new Error('submit: the version must be an integer (I5)')
  }
  if (typeof value.id !== 'string') throw new Error('submit: the id must be a string (I1)')
  if (typeof value.at !== 'number') throw new Error('submit: the at must be a number (I6)')
  if (typeof value.actor !== 'string') {
    throw new Error('submit: the actor must name a principal (ID-2)')
  }
  const values = payload.values ?? {}
  if (!isRecord(values)) throw new Error('submit: the values must be an object (FM-7)')
  return {
    id: value.id,
    type: INSTANCE_SUBMITTED,
    at: value.at,
    actor: value.actor,
    payload: {
      instanceId: payload.instanceId,
      version: payload.version,
      values: values as Record<string, JsonValue>,
    },
  }
}

/** Why a draft edit or a submit is refused before the content is looked at (ADR 0014, D1). */
function draftRefusal(
  instance: Instance,
  actor: ActorId,
  action: 'edit' | 'submit'
): string | undefined {
  if (instance.submitted !== false) {
    return `the instance is not a draft, so it cannot be ${action === 'edit' ? 'edited' : 'submitted'} again`
  }
  if (instance.starter !== actor) return `${actor} is not the starter of the draft`
  return undefined
}

/**
 * The request form (ADR 0014): the first step of the definition. A definition
 * always has one step (DF-1), so a start always has a form to sit on.
 */
function requestStep(definition: FlowDefinition): FlowStep {
  const [first] = definition.steps
  if (first === undefined) throw new Error('instance: the definition has no step (DF-1)')
  return first
}

/**
 * The keys the starter may capture on the request form (FM-3, ADR 0014): the
 * step's editable keys, or every field of the form when the step lists none,
 * because the request form is the starter's own.
 */
function requestEditable(step: FlowStep): readonly string[] {
  return step.editable ?? fieldsOf(step).map((field) => field.key)
}

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
 * The task-assigned emails of a step's assignees (SE-1, SE-2, I2): one
 * `send-assignment` entry per resolved member, in resolution order, each
 * naming the recipient and the step. A step whose targets resolved to nobody
 * sends none; the Unroutable alert covers it (I10).
 */
export function assignmentEmails(assignees: readonly Assignee[]): readonly OutboxEntry[] {
  const members = [...new Set(assignees.flatMap((assignee) => assignee.members))]
  return members.map((to) => ({
    operation: ASSIGNMENT_EMAIL,
    target: EMAIL_CONNECTOR,
    payload: { to, step: assignees[0]?.step ?? '' },
  }))
}
