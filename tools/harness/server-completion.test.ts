import { expect, test } from 'vitest'
import { claim, STEP_COMPLETED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import { createFlow, publish, push } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { startInstance, submitInstance } from '../../engine/submission.js'
import { startApi } from './server.js'

// Issue #191, FM-3, FM-4, FM-7, AC-4, AS-2, ADR 0010, DX-1, I1, I6, I8, A9:
// the completion intent on the public write path. A client posts the instance,
// the outcome it chose and the values it captured; the server resolves the
// current step, the transition, the outcome's authorization and the
// editability of every captured field through the engine before it appends.
// The appended event keeps the client's ID and time (I1, I6). The engine
// refusal is a 409 that names the field (FM-3) or the step, a malformed or
// unresolvable intent is a 400, and an already-resolved completion keeps the
// low-level append path.

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

/** The flow of the test, ready for a start at version 1 (DF-2). */
const flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

/** The directory of the test (AS-1): a starter target resolves to Sam, a user target to itself. */
const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('user' in target) return [target.user]
  return []
}

/** Sam's start grant (AC-1). */
const samGrants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** Okafor's outcome grant on the review step (AC-4): he may choose `approve` and no other outcome. */
const approveGrants: readonly Grant[] = [
  { principal: OKAFOR, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}` },
]

/** The injected sources of the fixture (I6): a fixed time and `op-N` IDs. */
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

/**
 * The state the server serves: the definition published (DF-2), Sam's start
 * and submit (S06, ADR 0014), which routes the instance to the review step,
 * and Okafor's claim of that step (S09, AS-2), so the instance has a holder
 * to complete. The client that posts the completion intent decides none of it.
 */
function startedState(): State {
  const sources = deps()
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  let state = apply(published.operation, apply(pushed.operation, emptyState))
  const started = startInstance(
    flow,
    INSTANCE_ID,
    { summary: 'hello' },
    SAM,
    sources,
    resolve,
    samGrants
  )
  state = apply(started.operation, state)
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
  const claimed = claim(submitted.instance, OKAFOR, submitted.instance.version ?? 0, sources)
  if (!claimed.accepted || claimed.operation === undefined) {
    throw new Error(`the claim was refused: ${claimed.reason}`)
  }
  return apply(claimed.operation, state)
}

/** Start the server on a loopback port, and close it when the callback returns. */
async function withApi(
  state: State,
  options: Parameters<typeof startApi>[1],
  body: (base: string, api: ReturnType<typeof startApi>) => Promise<void>
): Promise<void> {
  const api = startApi(state, options)
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  try {
    await body(`http://127.0.0.1:${api.port()}`, api)
  } finally {
    await new Promise<void>((resolve, reject) =>
      api.server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}

/** Post one JSON value to the write path and answer the response. */
async function post(base: string, value: unknown): Promise<Response> {
  return fetch(`${base}/api/v1/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
}

/** A completion intent: the instance, the outcome the actor chose and the values the step captured (FM-7). */
function completionIntent(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'complete-1',
    type: STEP_COMPLETED,
    at: 9,
    actor: OKAFOR,
    payload: { instanceId: INSTANCE_ID, version: 2, outcome: 'approve', values },
  }
}

test('#191 a completion intent resolves to the engine operation and keeps the client id and time', async () => {
  await withApi(startedState(), { resolve, grants: approveGrants }, async (base, api) => {
    const before = api.state().log.length
    const response = await post(base, completionIntent({ decision: 'approve' }))
    expect(response.status).toBe(201)
    const event = (await response.json()) as {
      operationId: string
      type: string
      at: number
      actor: string
      payload: Record<string, unknown>
    }
    // The client's ID and time survive (I1, I6), and the engine decided the
    // step, the outcome's authorization and the end of the flow (AC-4, WF-1,
    // A9): the review step is the last, so no next step's assignees follow.
    expect(event.operationId).toBe('complete-1')
    expect(event.at).toBe(9)
    expect(event.type).toBe(STEP_COMPLETED)
    expect(event.actor).toBe(OKAFOR)
    expect(event.payload).toEqual({
      instanceId: INSTANCE_ID,
      step: 'review',
      outcome: 'approve',
      values: { decision: 'approve' },
    })
    expect(api.state().log).toHaveLength(before + 1)
    expect(api.state().log.at(-1)?.operationId).toBe('complete-1')
  })
})

test('#191 FM-3 the server refuses a completion that changes a field the step does not make editable, naming the field', async () => {
  await withApi(startedState(), { resolve, grants: approveGrants }, async (base, api) => {
    const before = api.state().log.length
    // `detail` is a field of the request step, not of the review step the
    // instance sits on, so it is not editable on the current step (FM-3).
    const response = await post(base, completionIntent({ detail: 'private' }))
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('detail')
    expect(body.error).toMatch(/not editable/)
    expect(api.state().log).toHaveLength(before)
  })
})

test('#191 a completion intent without an instance id is refused with a named error and appends nothing', async () => {
  await withApi(startedState(), { resolve, grants: approveGrants }, async (base, api) => {
    const before = api.state().log.length
    const intent = completionIntent({ decision: 'approve' })
    const payload = { ...(intent.payload as Record<string, unknown>) }
    delete payload.instanceId
    const response = await post(base, { ...intent, payload })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toMatch(
      /instanceId must be a string/
    )
    expect(api.state().log).toHaveLength(before)
  })
})

test('#191 a completion intent that names an unknown instance is refused with a named error and appends nothing', async () => {
  await withApi(startedState(), { resolve, grants: approveGrants }, async (base, api) => {
    const before = api.state().log.length
    const intent = completionIntent({ decision: 'approve' })
    const response = await post(base, {
      ...intent,
      payload: { ...(intent.payload as Record<string, unknown>), instanceId: 'missing' },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toMatch(/no instance/)
    expect(api.state().log).toHaveLength(before)
  })
})

test('#191 an already-resolved step.completed@1 operation keeps the low-level append path', async () => {
  await withApi(startedState(), { resolve, grants: approveGrants }, async (base, api) => {
    const before = api.state().log.length
    // A resolved completion carries the `step` it acted on, so the server
    // appends it as it stands and resolves nothing (ADR 0010).
    const resolved = {
      id: 'resolved-1',
      type: STEP_COMPLETED,
      at: 11,
      actor: OKAFOR,
      payload: {
        instanceId: INSTANCE_ID,
        step: 'review',
        outcome: 'approve',
        values: {},
      },
    }
    const response = await post(base, resolved)
    expect(response.status).toBe(201)
    const event = (await response.json()) as { payload: Record<string, unknown> }
    expect(event.payload).toEqual(resolved.payload)
    expect(api.state().log).toHaveLength(before + 1)
  })
})
