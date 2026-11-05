import { expect, test } from 'vitest'
import { claim, complete } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { instanceOf } from '../engine/instances.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { trackerOf } from '../engine/tracker.js'

// Issue #256, S16, S10, WF-5, D6, A2, I4, I5, I8, I14: the generic undo is
// served through the shared resolver and projected. A compensating
// `event.undone@1` undoes the latest action on an instance (a claim, a
// release, a takeover, a reassign, a completion or a send back) within the
// flow's undo period, by the actor of that action or a flow owner; the
// original event stays on the log, the projection folds the instance as if
// the undone action never happened, and the flow's final step refuses an undo
// past it.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const LEE = 'user:lee'
const ANA = 'user:ana'
const PRIYA = 'user:priya'

const definition = parse(`{
  "schemaVersion": 2,
  "undoHours": 2,
  "finalStep": "registrar",
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "editable": ["summary"]
    },
    { "key": "advisor", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] },
    { "key": "registrar", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] },
    { "key": "archive", "targets": [{ "user": "user:archivist" }], "outcomes": ["file"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: LEE, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}` },
  { principal: ANA, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}` },
  { principal: PRIYA, scopes: ['task.reassign'], resource: `flow:${SLUG}` },
]

const resolve: TargetResolver = (target) => {
  if ('user' in target) return [target.user]
  if ('starter' in target) return [SAM]
  if ('team' in target) return [LEE, ANA]
  return []
}

const HOUR = 3_600_000
const T0 = 1_700_000_000_000

function deps(id: string, at: number): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/** The new resolver surface, typed loosely until it exists (#256): the file must type-check while it fails. */
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

/** The log with Lee's approval at the advisor step as the latest action. */
function approvedState(): { state: State; approvedSeq: number } {
  const pushed = push(createFlow(SLUG), definition, deps('push', T0), 'user:dana')
  const released = publish(pushed.flow, deps('publish', T0), 'user:dana')
  let state = apply(released.operation, apply(pushed.operation, emptyState))
  const started = startInstance(
    { slug: SLUG, versions: released.flow.versions },
    'inst-1',
    { summary: 'three' },
    SAM,
    deps('op-1', T0),
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
    deps('op-2', T0 + 1)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const current = () => {
    const instance = instanceOf(state.log, 'inst-1')
    if (instance === undefined) throw new Error('not projected')
    return instance
  }
  const claimed = claim(current(), LEE, current().version ?? 0, deps('op-3', T0 + 2))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  state = apply(claimed.operation, state)
  const approved = complete(
    current(),
    LEE,
    'approve',
    {},
    current().version ?? 0,
    { flow: SLUG, definition, grants, resolve },
    deps('op-4', T0 + 3)
  )
  if (approved.operation === undefined) throw new Error(approved.reason)
  state = apply(approved.operation, state)
  return { state, approvedSeq: state.log.length }
}

function undoIntent(
  seq: number,
  actor: string,
  version: number,
  at: number
): Record<string, unknown> {
  return {
    id: `undo-${seq}-${actor}-${at}`,
    type: 'event.undone@1',
    at,
    actor,
    payload: { instanceId: 'inst-1', eventId: seq, reason: 'Approved the wrong request', version },
  }
}

test.fails('#256 S16 an undo of the latest action is a compensating event and the projection folds it out', async () => {
  const { resolveClientOperation } = await resolverModule()
  const { state, approvedSeq } = approvedState()
  const context = (actor: string, now: number) => ({
    log: state.log,
    principal: { id: actor, groups: [] },
    grants,
    resolver: () => resolve,
    now: () => now,
  })
  const before = instanceOf(state.log, 'inst-1')
  expect(before?.currentStep).toBe('registrar')
  expect(before?.version).toBe(3)

  // A stranger may not undo (I8), a stale view is refused (I5), and the undo
  // period of the flow bounds it on the server clock (WF-5).
  const stranger = resolveClientOperation(
    context(ANA, T0 + 10),
    undoIntent(approvedSeq, ANA, 3, T0 + 10)
  )
  expect('status' in stranger && stranger.status).toBe(403)
  const stale = resolveClientOperation(
    context(LEE, T0 + 10),
    undoIntent(approvedSeq, LEE, 2, T0 + 10)
  )
  expect('status' in stale && stale.status).toBe(409)
  const late = resolveClientOperation(
    context(LEE, T0 + 3 + 3 * HOUR),
    undoIntent(approvedSeq, LEE, 3, T0 + 3 + 3 * HOUR)
  )
  expect('status' in late && late.error).toMatch(/period/)

  // Lee undoes his approval: the compensating event records the event it
  // covers, why and who, and the original stays on the log (D6, I4, I14).
  const undone = resolveClientOperation(
    context(LEE, T0 + 10),
    undoIntent(approvedSeq, LEE, 3, T0 + 10)
  )
  if (!('operation' in undone)) throw new Error(undone.error)
  expect(undone.operation.type).toBe('event.undone@1')
  expect(undone.operation.payload).toMatchObject({
    instanceId: 'inst-1',
    eventId: approvedSeq,
    reason: 'Approved the wrong request',
  })
  const after = apply(undone.operation, state)
  expect(after.log).toHaveLength(state.log.length + 1)
  expect(after.log[approvedSeq - 1].type).toBe('step.completed@1')

  // The projection folds the instance as if the approval never happened: Lee
  // holds the advisor step again, the version advanced by the undo (I5), and
  // the tracker shows the advisor opened and the registrar not reached.
  const restored = instanceOf(after.log, 'inst-1')
  expect(restored?.currentStep).toBe('advisor')
  expect(restored?.holder).toBe(LEE)
  expect(restored?.done).toBe(false)
  expect(restored?.version).toBe(4)
  expect(
    trackerOf(restored ?? before ?? ({} as never), definition, after.log).map((s) => s.state)
  ).toEqual(['completed', 'opened', 'not-reached', 'not-reached'])

  // The same event cannot be undone twice, and an action that is not the
  // latest on the instance (the claim under the approval) is refused with the
  // reason.
  const again = resolveClientOperation(
    { ...context(LEE, T0 + 11), log: after.log },
    undoIntent(approvedSeq, LEE, 4, T0 + 11)
  )
  expect('status' in again && again.status).toBe(409)
  const claimSeq = approvedSeq - 1
  const notLatest = resolveClientOperation(
    context(LEE, T0 + 10),
    undoIntent(claimSeq, LEE, 3, T0 + 10)
  )
  expect('status' in notLatest && notLatest.error).toMatch(/latest/)

  // A flow owner (task.reassign) may undo the claim that is now the latest
  // action; the task returns to the pool.
  const ownerUndo = resolveClientOperation(
    { ...context(PRIYA, T0 + 12), log: after.log },
    undoIntent(claimSeq, PRIYA, 4, T0 + 12)
  )
  if (!('operation' in ownerUndo)) throw new Error(ownerUndo.error)
  const pooled = instanceOf(apply(ownerUndo.operation, after).log, 'inst-1')
  expect(pooled?.holder).toBeUndefined()
  expect(pooled?.currentStep).toBe('advisor')
})

test.fails('#256 S16 the flow final step refuses an undo past it with the reason', async () => {
  const { resolveClientOperation } = await resolverModule()
  const { state } = approvedState()
  const current = () => {
    const instance = instanceOf(log, 'inst-1')
    if (instance === undefined) throw new Error('not projected')
    return instance
  }
  let log = state.log
  const claimed = claim(current(), ANA, current().version ?? 0, deps('op-5', T0 + 4))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  log = apply(claimed.operation, { applied: new Set(log.map((e) => e.operationId)), log }).log
  const filed = complete(
    current(),
    ANA,
    'approve',
    {},
    current().version ?? 0,
    { flow: SLUG, definition, grants, resolve },
    deps('op-6', T0 + 5)
  )
  if (filed.operation === undefined) throw new Error(filed.reason)
  log = apply(filed.operation, { applied: new Set(log.map((e) => e.operationId)), log }).log
  // The registrar step is the flow's final step: its completion is past the
  // point the flow marks final, so the undo is refused with the reason (S16).
  const refused = resolveClientOperation(
    { log, principal: { id: ANA, groups: [] }, grants, resolver: () => resolve, now: () => T0 + 6 },
    undoIntent(log.length, ANA, 5, T0 + 6)
  )
  expect('status' in refused && refused.status).toBe(409)
  expect('status' in refused && refused.error).toMatch(/final/)
})
