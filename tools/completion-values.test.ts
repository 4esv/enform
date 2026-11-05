import { expect, test } from 'vitest'
import { claim, complete, STEP_COMPLETED } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, publish, push } from '../engine/flow.js'
import { contentHash, type Instance } from '../engine/instance.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #191, #256, FM-3, FM-7, FM-4, AS-2, I8, A9, ADR 0014: the write rule
// of FM-3, in the engine. A completion records the values that the step
// captured (FM-7), and the engine refuses a captured key the current step does
// not make editable, naming the field (FM-3 criterion 2, FM-4). The refusal
// uses the same function that the step-scoped read uses for `editable`
// (engine/editable.ts), so a field the read does not list is exactly a field
// the completion refuses. The instance sits on the review step: the starter
// submitted the request form, and Okafor holds the review. The rule lives in
// the engine only (A9): the CLI, the API and the interface do not repeat it.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'

/** The instance id that the start mints (DX-1, #187): deterministic, like every injected source (I6). */
const INSTANCE_ID = 'inst-1'

/** A two-step flow: the request step makes only `summary` editable, the review step `decision` (FM-3). */
const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text" },
        { "key": "detail", "control": "long-text" }
      ],
      "visible": ["summary"],
      "editable": ["summary"],
      "outcomes": ["submit"]
    },
    {
      "key": "review",
      "targets": [{ "user": "${OKAFOR}" }],
      "fields": [{ "key": "decision", "control": "select", "options": ["approve"] }],
      "editable": ["decision"],
      "outcomes": ["approve"]
    }
  ]
}
`)

/** A flow whose review step declares no `editable`, so it makes no field editable (FM-3). */
const lockedDefinition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "editable": ["summary"]
    },
    {
      "key": "review",
      "targets": [{ "user": "${OKAFOR}" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "outcomes": ["approve"]
    }
  ]
}
`)

/** The values that the start routes with (FM-7). */
const data: ConditionData = { summary: 'hello' }

/** The directory of the test (AS-1): a starter target resolves to Sam, a user target to itself. */
const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('user' in target) return [target.user]
  return []
}

/** Sam's grant (AC-1): he may start the flow, and the starter submits the request form (ADR 0014). */
const samGrants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** Okafor's grant (AC-4): he may approve the review step. */
const grants: readonly Grant[] = [
  { principal: OKAFOR, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}` },
]

/** The injected sources of the test (I6): a fixed time and `op-N` IDs. */
function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

/** The flow of the test, ready for a start at version 1 (DF-2). */
function flowOf(definition: FlowDefinition): Flow {
  return {
    slug: SLUG,
    versions: [{ version: 1, contentHash: contentHash(definition), definition }],
  }
}

/** A log with the definition published (DF-2), so the projection can pin the instance to it. */
function seeded(definition: FlowDefinition, sources: OperationDeps): State {
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/**
 * The claimed instance of the review step (S06, S09, AS-2, I5, ADR 0014): a
 * start, the starter's submit, which routes to the review, then Okafor's
 * claim, so a completion has a holder. The state carries the log, so the read
 * can project the same instance.
 */
function claimed(
  definition: FlowDefinition,
  sources: OperationDeps
): { readonly instance: Instance; readonly state: State } {
  const started = startInstance(
    flowOf(definition),
    INSTANCE_ID,
    data,
    SAM,
    sources,
    resolve,
    samGrants
  )
  let state = apply(started.operation, seeded(definition, sources))
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: samGrants },
    sources
  )
  if (!submitted.accepted || submitted.operation === undefined) {
    throw new Error(`the submit was refused: ${submitted.reason}`)
  }
  state = apply(submitted.operation, state)
  const claimResult = claim(submitted.instance, OKAFOR, submitted.instance.version ?? 0, sources)
  if (!claimResult.accepted || claimResult.operation === undefined) {
    throw new Error(`the claim was refused: ${claimResult.reason}`)
  }
  return { instance: claimResult.instance, state: apply(claimResult.operation, state) }
}

/** The completion context of the test (S09): the flow, its definition and the actor's grants. */
function completion(definition: FlowDefinition): {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly grants: readonly Grant[]
} {
  return { flow: SLUG, definition, grants }
}

test('#191 FM-7 a completion records the values the step captured in step.completed@1', () => {
  const sources = deps()
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    OKAFOR,
    'approve',
    { decision: 'approve' },
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(true)
  if (result.operation === undefined) {
    throw new Error(`the completion was refused: ${result.reason}`)
  }
  expect(result.operation.type).toBe(STEP_COMPLETED)
  // The captured values ride in the payload beside the step and the outcome
  // (FM-7).
  expect(result.operation.payload.values).toEqual({ decision: 'approve' })
  expect(result.operation.payload.step).toBe('review')
  expect(result.operation.payload.outcome).toBe('approve')
})

test('#191 FM-3 a completion refuses a value the step does not make editable, naming the field', () => {
  const sources = deps()
  const { instance } = claimed(definition, sources)
  // `summary` and `detail` are fields of the request step, not of the review
  // step the instance sits on, and `other` names no field at all: none of
  // them is editable here (FM-3).
  for (const key of ['summary', 'detail', 'other']) {
    const result = complete(
      instance,
      OKAFOR,
      'approve',
      { [key]: 'value' },
      instance.version ?? 0,
      completion(definition),
      sources
    )
    expect(result.accepted, `${key} was accepted`).toBe(false)
    expect(result.operation).toBeUndefined()
    expect(result.reason, `${key} is not named in the reason`).toContain(key)
    expect(result.instance).toBe(instance)
  }

  // A step that declares no `editable` makes no field editable, so a captured
  // key is refused there too (FM-3).
  const locked = claimed(lockedDefinition, sources)
  const refused = complete(
    locked.instance,
    OKAFOR,
    'approve',
    { summary: 'hello' },
    locked.instance.version ?? 0,
    completion(lockedDefinition),
    sources
  )
  expect(refused.accepted).toBe(false)
  expect(refused.reason).toContain('summary')
})

test('#191 a completion with an empty values record is accepted and advances as before', () => {
  const sources = deps()
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    OKAFOR,
    'approve',
    {},
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(true)
  expect(result.operation?.payload.values).toEqual({})
  // The step still advances and clears the holder, exactly as it did before
  // the values parameter: a step that captures nothing is not a regression.
  // The review step is the last, so the instance is done (WF-1).
  expect(result.instance.currentStep).toBeUndefined()
  expect(result.instance.holder).toBeUndefined()
  expect(result.instance.done).toBe(true)
})

test('#191 FM-3 the read and the write agree on the editable field keys', () => {
  const sources = deps()
  const { instance, state } = claimed(definition, sources)
  const projected = instanceOf(state.log, INSTANCE_ID)
  if (projected === undefined) throw new Error('the log holds no instance')
  const view = readInstance(OKAFOR, projected, {
    flow: SLUG,
    definition,
    log: state.log,
    grants,
  })
  expect(view?.editable).toEqual(['decision'])
  // A field the read lists as editable is accepted and a field it does not
  // list is refused, so the read and the write share one rule and cannot
  // disagree (FM-3, FM-4).
  // The value of `decision` is one of its options, so only the editability
  // decides (FM-3), not the control's validation (FM-4).
  for (const key of ['decision', 'summary', 'detail']) {
    const result = complete(
      instance,
      OKAFOR,
      'approve',
      { [key]: key === 'decision' ? 'approve' : 'value' },
      instance.version ?? 0,
      completion(definition),
      sources
    )
    expect(result.accepted, `${key}`).toBe(view?.editable.includes(key))
  }
})
