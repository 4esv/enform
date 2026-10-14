import { expect, test } from 'vitest'
import { claim, complete, STEP_COMPLETED } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { contentHash, type Instance } from '../engine/instance.js'
import { instanceOf } from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance } from '../engine/submission.js'
import { startApi } from './harness/server.js'

// Issue #77, FM-4, FM-2, FM-7, FM-1, I1, I6, A9: the server re-runs every rule
// and every validation at a submission. FM-4: the server runs all rules and
// validation again at each submission and does not trust client state. A
// completion runs the step's rules again over the state the submission creates,
// validates every captured value against its control (validateField), and
// refuses with every error named by field path. A skipped field drops out of
// the capture (FM-2), a hidden field is neither required nor validated, and a
// refusal appends nothing (I1). The engine path (`complete`) and the intent path
// (through the server) give the same decision, so they cannot diverge (A9).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'

/** The instance id that the start mints (DX-1, #187): deterministic, like every injected source (I6). */
const INSTANCE_ID = 'inst-1'

/**
 * A two-step flow whose request step carries the fields the checks vary
 * (FM-1, FM-2). `amount` and `summary` are editable; `hidden` says required
 * but the step does not make it visible, so nobody can fill it. The rules are
 * the argument, so each check states the rule it needs.
 */
function definitionWith(rules: string): FlowDefinition {
  return parse(`{
    "schemaVersion": 2,
    "steps": [
      {
        "key": "request",
        "targets": [{ "starter": "starter" }],
        "fields": [
          { "key": "amount", "control": "number" },
          { "key": "summary", "control": "text" },
          { "key": "note", "control": "text" },
          { "key": "hidden", "control": "text", "required": true }
        ],
        "visible": ["amount", "summary", "note"],
        "editable": ["amount", "summary", "note", "hidden"],
        "outcomes": ["submit"],
        "rules": ${rules}
      },
      {
        "key": "review",
        "targets": [{ "user": "${OKAFOR}" }],
        "fields": [{ "key": "decision", "control": "select", "options": ["approve"] }],
        "editable": ["decision"],
        "outcomes": ["approve"]
      }
    ]
  }`)
}

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
function flowOf(definition: FlowDefinition): {
  readonly slug: string
  readonly versions: readonly {
    readonly version: number
    readonly contentHash: string
    readonly definition: FlowDefinition
  }[]
} {
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

/** The claimed instance of the request step (S09, AS-2, I5): a start then a claim, so a completion has a holder. */
function claimed(
  definition: FlowDefinition,
  sources: OperationDeps
): { readonly instance: Instance; readonly state: State } {
  const started = startInstance(flowOf(definition), INSTANCE_ID, {}, SAM, sources, resolve, grants)
  const state = apply(started.operation, seeded(definition, sources))
  const claimResult = claim(started.instance, SAM, started.instance.version ?? 0, sources)
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

test('#77 FM-4 a completion refuses a captured value that fails its control, naming the field path', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    SAM,
    'submit',
    { amount: 'lots' },
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(false)
  expect(result.operation).toBeUndefined()
  expect(result.errors).toEqual([{ path: 'amount', message: 'must be a number' }])
  // The refusal appends nothing (I1).
  expect(result.instance).toBe(instance)
})

test('#77 FM-4 a completion refuses a required field the step will hold empty, naming the field', () => {
  const sources = deps()
  const definition = definitionWith(
    `[{ "when": true, "effect": "require", "targets": ["summary"] }]`
  )
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
  expect(result.accepted).toBe(false)
  expect(result.errors).toEqual([{ path: 'summary', message: 'is required' }])
})

test('#77 FM-4 a completion reports every error by path, not one', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    SAM,
    'submit',
    { amount: 'lots', summary: 42 },
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(false)
  // Both bad values are named, in definition order (FM-4).
  expect(result.errors?.map((error) => error.path)).toEqual(['amount', 'summary'])
})

test('#77 FM-4 a skipped field is dropped from the capture: not recorded, not validated, no error', () => {
  const sources = deps()
  const definition = definitionWith(`[
    { "when": true, "effect": "require", "targets": ["note"] },
    { "when": true, "effect": "skip", "targets": ["note"] }
  ]`)
  const { instance } = claimed(definition, sources)
  // `note` would fail a validation and a require rule, but skip wins (FM-2,
  // Axel 2026-10-13): the value is not recorded, not validated and never
  // refused.
  const result = complete(
    instance,
    SAM,
    'submit',
    { note: 42, summary: 'hello' },
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(true)
  expect(result.errors).toBeUndefined()
  expect(result.operation?.payload.values).toEqual({ summary: 'hello' })
})

test('#77 FM-4 a hidden required field does not block the submission', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = claimed(definition, sources)
  // `hidden` says required in the definition, but the step does not make it
  // visible, so the rules make it not required (FM-2): nobody can fill it.
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
  expect(result.errors).toBeUndefined()
})

test('#77 FM-4 a valid submission succeeds and records exactly the values FM-7 expects', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = claimed(definition, sources)
  const result = complete(
    instance,
    SAM,
    'submit',
    { amount: 3, summary: 'hello' },
    instance.version ?? 0,
    completion(definition),
    sources
  )
  expect(result.accepted).toBe(true)
  expect(result.operation?.payload.values).toEqual({ amount: 3, summary: 'hello' })
})

test('#77 FM-4 the engine path and the completion intent refuse the same submission with the same errors', async () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { state } = claimed(definition, sources)
  const projected = instanceOf(state.log, INSTANCE_ID)
  if (projected === undefined) throw new Error('the log holds no instance')
  const values = { amount: 'lots' }

  // The engine path: `complete` called directly.
  const direct = complete(
    projected,
    SAM,
    'submit',
    values,
    projected.version ?? 0,
    completion(definition),
    sources
  )
  expect(direct.accepted).toBe(false)

  // The intent path: the same submission through the server (ADR 0010). Both
  // read the same instance from the log and give the same decision (A9, FM-4).
  const api = startApi(state, { resolve, grants })
  await new Promise<void>((listening) => api.server.listen(0, '127.0.0.1', listening))
  try {
    const response = await fetch(`http://127.0.0.1:${api.port()}/api/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'complete-1',
        type: STEP_COMPLETED,
        at: 9,
        actor: SAM,
        payload: { instanceId: INSTANCE_ID, outcome: 'submit', values },
      }),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      error: string
      errors: readonly { path: string; message: string }[]
    }
    expect(body.error).toBe(direct.reason)
    expect(body.errors).toEqual(direct.errors)
    expect(api.state().log).toHaveLength(state.log.length)
  } finally {
    await new Promise<void>((closed, reject) =>
      api.server.close((error) => (error ? reject(error) : closed()))
    )
  }
})
