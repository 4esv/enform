import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { contentHash, type Instance } from '../engine/instance.js'
import { instanceOf } from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { INSTANCE_SUBMITTED, startInstance, submitInstance } from '../engine/submission.js'
import { startApi } from './harness/server.js'

// Issue #77, #256, FM-4, FM-2, FM-7, FM-1, I1, I6, A9, ADR 0014: the server
// re-runs every rule and every validation at a submission. FM-4: the server
// runs all rules and validation again at each submission and does not trust
// client state. The submit of the request form runs the step's rules again
// over the state the submission creates, validates every captured value
// against its control (validateField), and refuses with every error named by
// field path; a completion of a later step shares the same rule
// (`validateStep`). A skipped field drops out of the capture (FM-2), a hidden
// field is neither required nor validated, and a refusal appends nothing (I1).
// The engine path (`submitInstance`) and the intent path (through the server)
// give the same decision, so they cannot diverge (A9).

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

/** Sam's grant (AC-1): he may start the flow, and the starter submits the request form (ADR 0014). */
const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
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

/** The draft on the request form (S06, ADR 0014): a start, so the starter has a form to submit. */
function drafted(
  definition: FlowDefinition,
  sources: OperationDeps
): { readonly instance: Instance; readonly state: State } {
  const started = startInstance(flowOf(definition), INSTANCE_ID, {}, SAM, sources, resolve, grants)
  return {
    instance: started.instance,
    state: apply(started.operation, seeded(definition, sources)),
  }
}

/** The submit context of the test (ADR 0014): the flow, its definition, the resolver and the grants. */
function submission(definition: FlowDefinition): {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly resolve: TargetResolver
  readonly grants: readonly Grant[]
} {
  return { flow: SLUG, definition, resolve, grants }
}

/** Submit the draft with the captured values (FM-4): the engine path of the request form. */
function submit(
  instance: Instance,
  definition: FlowDefinition,
  values: Readonly<Record<string, import('../engine/definition.js').JsonValue>>,
  sources: OperationDeps
) {
  return submitInstance(
    instance,
    SAM,
    values,
    instance.version ?? 0,
    submission(definition),
    sources
  )
}

test('#77 FM-4 a submission refuses a captured value that fails its control, naming the field path', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = drafted(definition, sources)
  const result = submit(instance, definition, { amount: 'lots' }, sources)
  expect(result.accepted).toBe(false)
  expect(result.operation).toBeUndefined()
  expect(result.errors).toEqual([{ path: 'amount', message: 'must be a number' }])
  // The refusal appends nothing (I1).
  expect(result.instance).toBe(instance)
})

test('#77 FM-4 a submission refuses a required field the step will hold empty, naming the field', () => {
  const sources = deps()
  const definition = definitionWith(
    `[{ "when": true, "effect": "require", "targets": ["summary"] }]`
  )
  const { instance } = drafted(definition, sources)
  const result = submit(instance, definition, {}, sources)
  expect(result.accepted).toBe(false)
  expect(result.errors).toEqual([{ path: 'summary', message: 'is required' }])
})

test('#77 FM-4 a submission reports every error by path, not one', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = drafted(definition, sources)
  const result = submit(instance, definition, { amount: 'lots', summary: 42 }, sources)
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
  const { instance } = drafted(definition, sources)
  // `note` would fail a validation and a require rule, but skip wins (FM-2,
  // Axel 2026-10-13): the value is not recorded, not validated and never
  // refused.
  const result = submit(instance, definition, { note: 42, summary: 'hello' }, sources)
  expect(result.accepted).toBe(true)
  expect(result.errors).toBeUndefined()
  expect(result.operation?.payload.values).toEqual({ summary: 'hello' })
})

test('#77 FM-4 a hidden required field does not block the submission', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = drafted(definition, sources)
  // `hidden` says required in the definition, but the step does not make it
  // visible, so the rules make it not required (FM-2): nobody can fill it.
  const result = submit(instance, definition, { summary: 'hello' }, sources)
  expect(result.accepted).toBe(true)
  expect(result.errors).toBeUndefined()
})

test('#77 FM-4 a valid submission succeeds and records exactly the values FM-7 expects', () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { instance } = drafted(definition, sources)
  const result = submit(instance, definition, { amount: 3, summary: 'hello' }, sources)
  expect(result.accepted).toBe(true)
  expect(result.operation?.payload.values).toEqual({ amount: 3, summary: 'hello' })
})

test('#77 FM-4 the engine path and the submit intent refuse the same submission with the same errors', async () => {
  const sources = deps()
  const definition = definitionWith('[]')
  const { state } = drafted(definition, sources)
  const projected = instanceOf(state.log, INSTANCE_ID)
  if (projected === undefined) throw new Error('the log holds no instance')
  const values = { amount: 'lots' }

  // The engine path: `submitInstance` called directly.
  const direct = submit(projected, definition, values, sources)
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
        id: 'submit-1',
        type: INSTANCE_SUBMITTED,
        at: 9,
        actor: SAM,
        payload: { instanceId: INSTANCE_ID, version: 0, values },
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
