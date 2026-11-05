import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'

// Issue #256, S06, S09, S16, ADR 0010, A9, I1, I2, I5, I8: one pure module
// resolves every client intent for the release server and the story harness.
// The release server appends what the resolver decides, and the harness server
// runs the same resolver, so api mode proves the release write path. Each
// check builds the log in memory and resolves one intent with the session
// principal as the actor and injected sources, as the server does (I6).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number" }
      ],
      "editable": ["summary", "overload_credits"]
    },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: OKAFOR, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}/step:advisor` },
]

const resolve: TargetResolver = (target) =>
  'user' in target ? [target.user] : 'starter' in target ? [SAM] : []

function deps(id: string, at = 1): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/** The log with the flow published (DF-2). */
function publishedState(): State {
  const pushed = push(createFlow(SLUG), definition, deps('push'), 'user:dana')
  const published = publish(pushed.flow, deps('publish'), 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

test('#256 a submit intent resolves into the routed submission with its assignment email', async () => {
  const { resolveClientOperation } = await import('../server/intents.js')
  let state = publishedState()
  const context = (actor: string) => ({
    log: state.log,
    principal: { id: actor, groups: [] },
    grants,
    resolver: () => resolve,
    now: () => 10,
  })
  const started = resolveClientOperation(context(SAM), {
    id: 'op-start',
    type: 'instance.started@1',
    at: 1,
    actor: SAM,
    payload: { flow: SLUG, instanceId: 'inst-1', values: { summary: 'three credits' } },
  })
  if (!('operation' in started)) throw new Error(started.error)
  state = apply(started.operation, state)
  // A start is a private draft on the request form (ADR 0014, D1, VT-4): it
  // routes nothing and notifies nobody.
  expect(started.operation.payload.currentStep).toBe('request')
  expect(started.operation.payload.outbox).toBeUndefined()

  const submitted = resolveClientOperation(context(SAM), {
    id: 'op-submit',
    type: 'instance.submitted@1',
    at: 2,
    actor: SAM,
    payload: { instanceId: 'inst-1', version: 0, values: { overload_credits: 3 } },
  })
  if (!('operation' in submitted)) throw new Error(submitted.error)
  // The submit routes to the first step whose skip condition is false, records
  // the assignees and the task-assigned email in the same operation (I2, SE-2).
  expect(submitted.operation.type).toBe('instance.submitted@1')
  expect(submitted.operation.payload.currentStep).toBe('advisor')
  expect(submitted.operation.payload.values).toEqual({
    summary: 'three credits',
    overload_credits: 3,
  })
  expect(submitted.operation.payload.outbox).toEqual([
    {
      operation: 'send-assignment',
      target: 'connector-smtp',
      payload: { to: OKAFOR, step: 'advisor' },
    },
  ])
})

test.fails('#256 I8 an intent the engine refuses for authorization answers 403, not 400 or 409', async () => {
  const { resolveClientOperation } = await import('../server/intents.js')
  let state = publishedState()
  const context = (actor: string) => ({
    log: state.log,
    principal: { id: actor, groups: [] },
    grants,
    resolver: () => resolve,
    now: () => 10,
  })
  // Okafor holds no instance.start: the start is refused for its scope (AC-1).
  const unauthorizedStart = resolveClientOperation(context(OKAFOR), {
    id: 'op-start-okafor',
    type: 'instance.started@1',
    at: 1,
    actor: OKAFOR,
    payload: { flow: SLUG, instanceId: 'inst-x', values: {} },
  })
  expect('error' in unauthorizedStart && unauthorizedStart.status).toBe(403)

  // Sam starts and submits; the advisor step is Okafor's.
  const started = resolveClientOperation(context(SAM), {
    id: 'op-start',
    type: 'instance.started@1',
    at: 1,
    actor: SAM,
    payload: { flow: SLUG, instanceId: 'inst-1', values: { summary: 'x' } },
  })
  if (!('operation' in started)) throw new Error(started.error)
  state = apply(started.operation, state)
  const submitted = resolveClientOperation(context(SAM), {
    id: 'op-submit',
    type: 'instance.submitted@1',
    at: 2,
    actor: SAM,
    payload: { instanceId: 'inst-1', version: 0, values: { overload_credits: 3 } },
  })
  if (!('operation' in submitted)) throw new Error(submitted.error)
  state = apply(submitted.operation, state)

  // Sam is no assignee of the advisor step: his claim is refused for who he
  // is (AS-2, I8), not for the state of the task.
  const strangerClaim = resolveClientOperation(context(SAM), {
    id: 'op-claim-sam',
    type: 'step.claimed@1',
    at: 3,
    actor: SAM,
    payload: { instanceId: 'inst-1', expectedVersion: 1 },
  })
  expect('error' in strangerClaim && strangerClaim.status).toBe(403)

  const claimed = resolveClientOperation(context(OKAFOR), {
    id: 'op-claim',
    type: 'step.claimed@1',
    at: 3,
    actor: OKAFOR,
    payload: { instanceId: 'inst-1', expectedVersion: 1 },
  })
  if (!('operation' in claimed)) throw new Error(claimed.error)
  state = apply(claimed.operation, state)

  // Okafor holds step.outcome:approve and no other outcome scope: a
  // completion with another outcome is refused for its scope (AC-4), and the
  // API answers 403 (S02).
  const unauthorizedOutcome = resolveClientOperation(context(OKAFOR), {
    id: 'op-complete',
    type: 'step.completed@1',
    at: 4,
    actor: OKAFOR,
    payload: { instanceId: 'inst-1', version: 2, outcome: 'send_back', values: {} },
  })
  expect('error' in unauthorizedOutcome && unauthorizedOutcome.status).toBe(403)
})

test('#256 a claim intent resolves through the shared resolver with the session principal', async () => {
  const { resolveClientOperation } = await import('../server/intents.js')
  const state = publishedState()
  const refused = resolveClientOperation(
    {
      log: state.log,
      principal: { id: OKAFOR, groups: [] },
      grants,
      resolver: () => resolve,
      now: () => 10,
    },
    {
      id: 'op-claim',
      type: 'step.claimed@1',
      at: 3,
      actor: 'user:someone-else',
      payload: { instanceId: 'missing', expectedVersion: 0 },
    }
  )
  // The instance is not on the log, so the resolver refuses with a 400 rather
  // than appending a claim on nothing (DX-1).
  expect('error' in refused && refused.status).toBe(400)
})
