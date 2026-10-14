// Issue #46, S09, AS-2, AC-4, I5, I6, I8, I14, A1, A9: claim and complete a task.
// Issue #76, DX-1, #187: a claim and a completion name the instance they act
// on, so the log says which instance each step operation belongs to.
// Issue #77, FM-4, FM-2, FM-1, I1, A9: a completion re-runs the step's rules
// and validates every captured value, refusing with every error named by path.
//
// S09: the registrar task shows in the Available tab of Lee and of Ana. To
// open it claims nothing (AS-2): the first person to claim the task owns it,
// and a second claim on the same view is refused, so exactly one succeeds and
// nobody blocks (I5). The holder completes the task with an outcome, and the
// engine authorizes that outcome from the grants of the holder (AC-4, I8): a
// `step.outcome:<name>` scope allows that outcome and no other. A claim and a
// completion each carry the version of the view that they are based on, and a
// stale view is refused at once (I5). Both are attributed operations on the
// append-only log (I14), and both functions are pure and deterministic (I6):
// they read no clock, no random source and no I/O of their own.

import { authorize, type Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import { type FlowDefinition, type FlowStep, fieldsOf, type JsonValue } from './definition.js'
import { editableKeys } from './editable.js'
import { type FieldError, validateField } from './fields.js'
import { type Instance, recordAssignees } from './instance.js'
import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'
import { resolveAssignees, type TargetResolver } from './routing.js'
import { evaluateRules, type StepRuleState } from './rules.js'

/** The versioned event type of a claim (S09, AS-2). */
export const STEP_CLAIMED = 'step.claimed@1'

/** The versioned event type of a completion (S09, WF-2). */
export const STEP_COMPLETED = 'step.completed@1'

/**
 * The result of a claim or a completion (I5, AS-2, AC-4). `accepted` says
 * whether the engine applied the transition. When it did not, the instance is
 * unchanged, `operation` is absent and `reason` says why: a stale view, an
 * actor that is not an assignee or not the holder, or an outcome that the
 * actor may not choose.
 */
export type ActionResult = {
  readonly accepted: boolean
  readonly instance: Instance
  /** The operation that records the accepted change (I14); absent when the engine refused. */
  readonly operation?: Operation
  /** Why the engine refused the action (I5, AS-2, AC-4); absent when it accepted. */
  readonly reason?: string
  /**
   * Every validation error of a refused submission, by field path (FM-4). It
   * is present only when the engine refused a completion for a validation
   * error; a refusal that `reason` names alone, such as a non-editable key
   * (FM-3), carries none.
   */
  readonly errors?: readonly FieldError[]
}

/**
 * The context that a completion needs (S09): the flow slug and the definition
 * that the instance runs on, so the engine can authorize the outcome on the
 * current step (AC-4) and advance to the next step (WF-1). `grants` are the
 * scopes that apply to the acting principal; when they are given the engine
 * authorizes the outcome from them (I8).
 */
export type CompletionContext = {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly grants?: readonly Grant[]
  /**
   * The resolver that the next step resolves through (AS-1, AS-4, I13). The
   * caller builds it from the instance, so the engine records the next step's
   * assignees in the same way a start records the first step's: a group or a
   * team resolves live, and a dynamic target resolves once with a snapshot. An
   * absent resolver resolves nothing, so the operation records no assignees
   * rather than inventing a resolution.
   */
  readonly resolve?: TargetResolver
}

/**
 * Claim the current step of an instance (S09, AS-2, AC-4, I5). The first
 * person to claim the task owns it, so the engine accepts the claim only when
 * the acting principal is an assignee of the current step and the claim is
 * based on the current version of the log (I5). When the version is stale it
 * refuses at once and names the holder, so a second person sees that the first
 * claimed the task just now; when the principal is not an assignee it refuses
 * too. Nobody waits and the caller re-reads (I5). On acceptance the instance
 * records the holder and the operation records the claim (I14).
 */
export function claim(
  instance: Instance,
  actor: ActorId,
  expectedVersion: Version,
  deps: OperationDeps
): ActionResult {
  const step = instance.currentStep
  if (step === undefined) {
    return { accepted: false, instance, reason: 'the instance has no current step to claim' }
  }
  const version = currentVersion(instance)
  if (expectedVersion !== version) {
    return { accepted: false, instance, reason: claimRefusal(step, instance.holder) }
  }
  if (!isAssignee(instance, actor)) {
    return { accepted: false, instance, reason: `step ${step}: ${actor} is not an assignee` }
  }
  const claimed: Instance = { ...instance, holder: actor, version: version + 1 }
  const operation = createOperation(
    STEP_CLAIMED,
    { instanceId: instance.instanceId, step, holder: actor },
    deps,
    actor
  )
  return { accepted: true, instance: claimed, operation }
}

/**
 * Complete the current step of an instance with an outcome and the values that
 * the step captured (S09, AC-4, I5, FM-7). Only the holder may complete the
 * step, and the engine refuses a completion that is based on a stale version
 * of the log at once, so a holder with a stale view re-reads and there is no
 * second completion (I5). The engine authorizes the outcome from the grants
 * that apply to the holder (AC-4, I8): the holder must hold
 * `step.outcome:<outcome>` on the step. The engine then runs the step's rules
 * again over the state the submission creates (FM-2, FM-4) and checks every
 * captured key against the step's editable keys (FM-3, FM-4, A9), refusing a
 * key the step does not make editable, naming the field, so a client cannot
 * write a field the step locks. A key whose field is skipped drops out of the
 * capture; every other captured value is validated against its control, and a
 * required field the step will hold empty is refused. The refusal names every
 * error by field path in `errors` (FM-4). On acceptance the instance advances
 * to the next step, or is marked done when the step was the last, and the
 * operation records the outcome and the captured values (FM-7, I14). When the
 * caller gives a
 * resolver, the engine also records the next step's resolved assignees (AS-4,
 * I13), exactly as a start records the first step's.
 */
export function complete(
  instance: Instance,
  actor: ActorId,
  outcome: string,
  values: Readonly<Record<string, JsonValue>>,
  expectedVersion: Version,
  context: CompletionContext,
  deps: OperationDeps
): ActionResult {
  const step = instance.currentStep
  if (step === undefined) {
    return { accepted: false, instance, reason: 'the instance has no current step to complete' }
  }
  const version = currentVersion(instance)
  if (expectedVersion !== version) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: the view is stale, refresh and retry`,
    }
  }
  if (instance.holder !== actor) {
    return { accepted: false, instance, reason: `step ${step}: ${actor} does not hold the step` }
  }
  const resource = stepResource(context.flow, step)
  if (
    context.grants !== undefined &&
    !authorize(context.grants, `step.outcome:${outcome}`, resource)
  ) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: ${actor} lacks step.outcome:${outcome} (AC-4)`,
    }
  }
  const definitionStep = context.definition.steps.find((candidate) => candidate.key === step)
  // FM-4, A9: the engine does not trust the client. It runs the step's rules
  // again over the state the submission creates, so a rule keyed on a value the
  // user just typed reads it exactly as the next read will: the values the step
  // will hold are the instance's values with the capture merged over them.
  const merged = { ...instance.values, ...values }
  const state =
    definitionStep === undefined ? undefined : evaluateRules(definitionStep, merged, actor)
  // FM-2: a skipped field drops out of the capture (Axel, 2026-10-13). Its
  // value is neither recorded nor validated, and it never refuses the
  // submission. Skip wins over the FM-3 refusal below, so a skipped key is
  // dropped before the editability check.
  const captured = Object.keys(values).filter((key) => state?.fields[key]?.skipped !== true)
  // The step's editable keys govern the remaining captured values (FM-3, FM-4,
  // A9). The read (readInstance) and this write share editableKeys, so a field
  // the read does not list in `editable` is exactly a field this refuses: a key
  // the step does not make editable, a key of another step, and a key that
  // names no field are all refused.
  const editable = definitionStep === undefined ? [] : editableKeys(actor, instance, definitionStep)
  const notEditable = captured.find((key) => !editable.includes(key))
  if (notEditable !== undefined) {
    return {
      accepted: false,
      instance,
      reason: `step ${step}: ${notEditable} is not editable on this step (FM-3)`,
    }
  }
  // FM-4: every remaining captured value is validated against its control, and
  // a required field the step will hold empty is an error. The engine reports
  // every error, each one named by field path.
  const errors =
    definitionStep === undefined || state === undefined
      ? []
      : checkStep(definitionStep, captured, values, merged, state)
  if (errors.length > 0) {
    return { accepted: false, instance, errors, reason: refusalReason(step, errors) }
  }
  const next = nextStep(context.definition, step)
  // The engine records the next step's resolved assignees exactly as a start
  // records the first step's (AS-4, I13). A caller that gives no resolver
  // records none, so the engine never invents a resolution.
  const entered =
    next === undefined || context.resolve === undefined
      ? undefined
      : resolveAssignees(next, context.resolve)
  const advanced: Instance = {
    ...instance,
    holder: undefined,
    currentStep: next?.key,
    done: next === undefined,
    version: version + 1,
  }
  const completed = entered === undefined ? advanced : recordAssignees(advanced, entered)
  const change = {
    instanceId: instance.instanceId,
    step,
    outcome,
    // A skipped key is absent from the recorded capture (FM-2, FM-7).
    values: capture(values, captured),
    ...(entered === undefined ? {} : { assignees: entered }),
  }
  const operation = createOperation(STEP_COMPLETED, change, deps, actor)
  return { accepted: true, instance: completed, operation }
}

/** The version of the log that an instance view reflects (I5). An absent version is the empty log. */
function currentVersion(instance: Instance): Version {
  return instance.version ?? 0
}

/** Whether the acting principal is an assignee of the instance's current step (AC-4, AS-2). */
function isAssignee(instance: Instance, actor: ActorId): boolean {
  const step = instance.currentStep
  return instance.assignees.some(
    (assignee) => assignee.step === step && assignee.members.includes(actor)
  )
}

/** Why the engine refused a claim (AS-2, I5): a held task names the holder, an unheld one asks for a re-read. */
function claimRefusal(step: string, holder: ActorId | undefined): string {
  return holder === undefined
    ? `step ${step}: the view is stale, refresh and retry`
    : `step ${step}: claimed by ${holder} just now`
}

/**
 * The step that follows one key in definition order (WF-1); absent at the last
 * step. The completion advances to it, and the instance projection (#76) reads
 * the same transition, so the write path and the read cannot disagree.
 */
export function nextStep(definition: FlowDefinition, key: string): FlowStep | undefined {
  const index = definition.steps.findIndex((step) => step.key === key)
  return index === -1 ? undefined : definition.steps[index + 1]
}

/** The resource of one step (MVP.md 5.6): `flow:<slug>/step:<key>`. */
function stepResource(flow: string, key: string): string {
  return `flow:${flow}/step:${key}`
}

/**
 * Validate the captured values and the required fields of a step (FM-1, FM-2,
 * FM-4). A skipped field already dropped out of `captured`, so it is neither
 * validated nor required; a hidden field is neither validated nor required
 * either, because nobody can fill a field they cannot see. Every other
 * captured value is checked against its control through `validateField`, and a
 * required field whose value the step will hold is absent, null or an empty
 * string is an error. The fields are read in definition order, so the errors
 * come out in one deterministic order (I6).
 */
function checkStep(
  step: FlowStep,
  captured: readonly string[],
  values: Readonly<Record<string, JsonValue>>,
  merged: Readonly<Record<string, JsonValue>>,
  state: StepRuleState
): readonly FieldError[] {
  const errors: FieldError[] = []
  const isCaptured = new Set(captured)
  for (const field of fieldsOf(step)) {
    const fieldState = state.fields[field.key]
    if (fieldState === undefined || fieldState.skipped) continue
    if (fieldState.visible && isCaptured.has(field.key)) {
      const error = validateField(field, values[field.key])
      if (error !== undefined) errors.push(error)
    }
    if (fieldState.required && isEmpty(merged[field.key])) {
      errors.push({ path: field.key, message: 'is required' })
    }
  }
  return errors
}

/**
 * Whether a required field's value counts as empty (FM-4): absent, null or an
 * empty string. Every other value, including `false` and `0`, satisfies a
 * required field; no second emptiness rule exists for the other controls.
 */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** The refusal reason of a submission that fails validation, naming every error by path (FM-4). */
function refusalReason(step: string, errors: readonly FieldError[]): string {
  const named = errors.map((error) => `${error.path} ${error.message}`).join('; ')
  return `step ${step}: ${named} (FM-4)`
}

/** The capture after the skipped fields dropped out (FM-2, FM-4). */
function capture(
  values: Readonly<Record<string, JsonValue>>,
  keys: readonly string[]
): Record<string, JsonValue> {
  const kept: Record<string, JsonValue> = {}
  for (const key of keys) kept[key] = values[key]
  return kept
}
