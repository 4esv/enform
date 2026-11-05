import { expect, test } from 'vitest'
import { claim } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { instanceOf } from '../engine/instances.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import { outboxOf } from '../engine/outbox.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { trackerOf } from '../engine/tracker.js'

// Issue #256, WF-5, AS-2, AS-3, MVP.md 5.6 (`task.reassign`), I2, I5, I8,
// I14: a holder releases the task back to the pool, and a flow owner releases
// or reassigns any task, also one they are no target of. Both are attributed
// operations on the log; a reassign makes the new holder an assignee of the
// step and notifies them in the same operation.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const LEE = 'user:lee'
const ANA = 'user:ana'
const PRIYA = 'user:priya'
const JORDAN = 'user:jordan'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "registrar", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: PRIYA, scopes: ['task.reassign'], resource: `flow:${SLUG}` },
]

const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('team' in target) return [LEE, ANA]
  return []
}

function deps(id: string, at = 1): OperationDeps {
  return { clock: () => at, ids: () => id }
}

type Resolver = (
  context: {
    log: State['log']
    principal: { id: string; groups: readonly string[] }
    grants: readonly Grant[]
    resolver: () => TargetResolver
    now: () => number
  },
  body: Record<string, unknown>
) => { operation: Operation } | { status: number; error: string }

async function resolverModule(): Promise<{ resolveClientOperation: Resolver }> {
  return (await import('../server/intents.js')) as unknown as { resolveClientOperation: Resolver }
}

/** The log with Lee holding the registrar task. */
function heldState(): State {
  const pushed = push(createFlow(SLUG), definition, deps('push', 0), 'user:dana')
  const released = publish(pushed.flow, deps('publish', 0), 'user:dana')
  let state = apply(released.operation, apply(pushed.operation, emptyState))
  const started = startInstance(
    { slug: SLUG, versions: released.flow.versions },
    'inst-1',
    {},
    SAM,
    deps('op-1', 1),
    resolve,
    grants
  )
  state = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants },
    deps('op-2', 2)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('not projected')
  const claimed = claim(instance, LEE, instance.version ?? 0, deps('op-3', 3))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  return apply(claimed.operation, state)
}

function context(state: State, actor: string) {
  return {
    log: state.log,
    principal: { id: actor, groups: [] },
    grants: grants.filter((grant) => grant.principal === actor),
    resolver: () => resolve,
    now: () => 100,
  }
}

test('#256 WF-5 the holder releases the task and a flow owner releases or reassigns any task', async () => {
  const { resolveClientOperation } = await resolverModule()
  const state = heldState()
  const held = instanceOf(state.log, 'inst-1')
  expect(held?.holder).toBe(LEE)
  const version = held?.version ?? 0

  // Ana is a peer, not the holder and not an owner: she may not release
  // Lee's task (I8).
  const peer = resolveClientOperation(context(state, ANA), {
    id: 'rel-ana',
    type: 'task.released@1',
    at: 10,
    actor: ANA,
    payload: { instanceId: 'inst-1', version },
  })
  expect('status' in peer && peer.status).toBe(403)

  // Lee releases his own task: the holder is gone, the version advanced, and
  // the tracker shows the step waiting to be opened again (AS-2, I5).
  const released = resolveClientOperation(context(state, LEE), {
    id: 'rel-lee',
    type: 'task.released@1',
    at: 10,
    actor: LEE,
    payload: { instanceId: 'inst-1', version },
  })
  if (!('operation' in released)) throw new Error(released.error)
  expect(released.operation.payload).toEqual({
    instanceId: 'inst-1',
    step: 'registrar',
    holder: LEE,
  })
  const pooled = apply(released.operation, state)
  const open = instanceOf(pooled.log, 'inst-1')
  expect(open?.holder).toBeUndefined()
  expect(open?.version).toBe(version + 1)
  expect(trackerOf(open ?? held ?? ({} as never), definition, pooled.log)[1]).toMatchObject({
    key: 'registrar',
    state: 'unopened',
  })
  // A task nobody holds cannot be released again.
  const twice = resolveClientOperation(context(pooled, LEE), {
    id: 'rel-twice',
    type: 'task.released@1',
    at: 11,
    actor: LEE,
    payload: { instanceId: 'inst-1', version: version + 1 },
  })
  expect('status' in twice && twice.status).toBe(409)

  // Priya owns the flow (`task.reassign`) and is no target of the step: she
  // reassigns the task to Jordan with a reason. Jordan becomes the holder and
  // an assignee of the step, and is told in the same operation (I2, SE-2).
  const reassigned = resolveClientOperation(context(pooled, PRIYA), {
    id: 're-priya',
    type: 'task.reassigned@1',
    at: 12,
    actor: PRIYA,
    payload: { instanceId: 'inst-1', version: version + 1, to: JORDAN, reason: 'Lee is out' },
  })
  if (!('operation' in reassigned)) throw new Error(reassigned.error)
  expect(reassigned.operation.payload).toMatchObject({
    instanceId: 'inst-1',
    step: 'registrar',
    to: JORDAN,
    reason: 'Lee is out',
  })
  const given = apply(reassigned.operation, pooled)
  const jordans = instanceOf(given.log, 'inst-1')
  expect(jordans?.holder).toBe(JORDAN)
  expect(jordans?.version).toBe(version + 2)
  expect(
    jordans?.assignees.some(
      (assignee) => assignee.step === 'registrar' && assignee.members.includes(JORDAN)
    )
  ).toBe(true)
  expect(outboxOf(given.log).at(-1)).toEqual({
    operation: 'send-assignment',
    target: 'connector-smtp',
    payload: { to: JORDAN, step: 'registrar' },
  })
  expect(trackerOf(jordans ?? held ?? ({} as never), definition, given.log)[1]).toMatchObject({
    key: 'registrar',
    state: 'opened',
    holder: JORDAN,
  })

  // A reassign needs a reason and `task.reassign`; a stale view is refused.
  const noReason = resolveClientOperation(context(given, PRIYA), {
    id: 're-none',
    type: 'task.reassigned@1',
    at: 13,
    actor: PRIYA,
    payload: { instanceId: 'inst-1', version: version + 2, to: ANA, reason: '' },
  })
  expect('status' in noReason && noReason.status).toBe(400)
  const notOwner = resolveClientOperation(context(given, LEE), {
    id: 're-lee',
    type: 'task.reassigned@1',
    at: 13,
    actor: LEE,
    payload: { instanceId: 'inst-1', version: version + 2, to: ANA, reason: 'mine' },
  })
  expect('status' in notOwner && notOwner.status).toBe(403)
  const stale = resolveClientOperation(context(given, PRIYA), {
    id: 're-stale',
    type: 'task.reassigned@1',
    at: 13,
    actor: PRIYA,
    payload: { instanceId: 'inst-1', version: version, to: ANA, reason: 'stale' },
  })
  expect('status' in stale && stale.status).toBe(409)

  // The owner releases Jordan's task too: a release by an owner names the
  // holder it took the task from.
  const ownerRelease = resolveClientOperation(context(given, PRIYA), {
    id: 'rel-priya',
    type: 'task.released@1',
    at: 14,
    actor: PRIYA,
    payload: { instanceId: 'inst-1', version: version + 2, reason: 'Jordan is out too' },
  })
  if (!('operation' in ownerRelease)) throw new Error(ownerRelease.error)
  expect(ownerRelease.operation.payload).toEqual({
    instanceId: 'inst-1',
    step: 'registrar',
    holder: JORDAN,
    reason: 'Jordan is out too',
  })
  expect(instanceOf(apply(ownerRelease.operation, given).log, 'inst-1')?.holder).toBeUndefined()
})
