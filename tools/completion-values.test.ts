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
import { startInstance } from '../engine/submission.js'

// Issue #191, FM-3, FM-7, FM-4, AS-2, I8, A9: the write rule of FM-3, in the
// engine. A completion records the values that the step captured (FM-7), and
// the engine refuses a captured key the current step does not make editable,
// naming the field (FM-3 criterion 2, FM-4). The refusal uses the same function
// that the step-scoped read uses for `editable` (engine/editable.ts), so a
// field the read does not list is exactly a field the completion refuses. The
// rule lives in the engine only (A9): the CLI, the API and the interface do not
// repeat it.

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

/** A one-step flow whose step declares no `editable`, so it makes no field editable (FM-3). */
const lockedDefinition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "outcomes": ["submit"]
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

/** Sam's grants (AC-1, AC-4): he may start the flow and submit the request step. */
const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
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
 * The claimed instance of the request step (S09, AS-2, I5): a start then a
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
    grants
  )
  const state = apply(started.operation, seeded(definition, sources))
  const opened = state.log.length
  const claimResult = claim({ ...started.instance, version: opened }, SAM, opened, sources)
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

test.fails('#191 FM-7 a completion records the values the step captured in step.completed@1', () => {
  const sources = deps()
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    SAM,
    'submit',
    { summary: 'hello' },
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
  expect(result.operation.payload.values).toEqual({ summary: 'hello' })
  expect(result.operation.payload.step).toBe('request')
  expect(result.operation.payload.outcome).toBe('submit')
})

test.fails('#191 FM-3 a completion refuses a value the step does not make editable, naming the field', () => {
  const sources = deps()
  const { instance } = claimed(definition, sources)
  // `detail` is a field of the request step that it does not make editable,
  // `decision` is a field of the review step, and `other` names no field at
  // all: none of them is editable here (FM-3).
  for (const key of ['detail', 'decision', 'other']) {
    const result = complete(
      instance,
      SAM,
      'submit',
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
    SAM,
    'submit',
    { summary: 'hello' },
    locked.instance.version ?? 0,
    completion(lockedDefinition),
    sources
  )
  expect(refused.accepted).toBe(false)
  expect(refused.reason).toContain('summary')
})

test.fails('#191 a completion with an empty values record is accepted and advances as before', () => {
  const sources = deps()
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    SAM,
    'submit',
    {},
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(true)
  expect(result.operation?.payload.values).toEqual({})
  // The step still advances and clears the holder, exactly as it did before
  // the values parameter: a step that captures nothing is not a regression.
  expect(result.instance.currentStep).toBe('review')
  expect(result.instance.holder).toBeUndefined()
  expect(result.instance.done).toBe(false)
})

test.fails('#191 FM-3 the read and the write agree on the editable field keys', () => {
  const sources = deps()
  const { instance, state } = claimed(definition, sources)
  const projected = instanceOf(state.log, INSTANCE_ID)
  if (projected === undefined) throw new Error('the log holds no instance')
  const view = readInstance(SAM, projected, {
    flow: SLUG,
    definition,
    log: state.log,
    grants,
  })
  expect(view?.editable).toEqual(['summary'])
  // A field the read lists as editable is accepted and a field it does not
  // list is refused, so the read and the write share one rule and cannot
  // disagree (FM-3, FM-4).
  for (const key of ['summary', 'detail', 'decision']) {
    const result = complete(
      instance,
      SAM,
      'submit',
      { [key]: 'value' },
      instance.version ?? 0,
      completion(definition),
      sources
    )
    expect(result.accepted, `${key}`).toBe(view?.editable.includes(key))
  }
})
