import { expect, test } from 'vitest'
import { claim } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { instanceOf } from '../engine/instances.js'
import {
  DIRECTORY_ACTOR,
  deprovision,
  deprovisionedOf,
  USER_DEPROVISIONED,
  USER_PROVISIONED,
} from '../engine/membership.js'
import type { Log, OperationDeps } from '../engine/operation.js'
import { outboxOf } from '../engine/outbox.js'
import { ALERT_CONNECTOR, UNROUTABLE_ALERT, UNROUTABLE_QUEUE } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { timeline } from '../engine/timeline.js'
import { TASK_RELEASED } from '../engine/undo.js'
import { resolverFor } from '../server/intents.js'

// Issue #267, ID-5, ID-4, AS-1, AS-4, AS-5, I4, I10, I14, S08: deprovisioning
// through the log. A deprovision releases every task the user holds through
// the same `task.released@1` event a flow owner's release records, with the
// reason, so the timeline shows "returned to the pool" with why and the
// release stays undoable like any manual action (WF-5); one attributed
// `user.deprovisioned@1` event records the account. The log then says who is
// deprovisioned (`deprovisionedOf`), and the shared resolver routes a `user`,
// a `field`, a `starter` or a `manager-of` target that names such a person to
// nobody, so the task goes to the Unroutable queue with the owner alert (I10,
// S08). A later `user.provisioned@1` brings the person back.

const SLUG = 'course-overload'
const DANA = 'user:dana'
const PRIYA = 'user:priya'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'
const LEE = 'user:lee'
const ANA = 'user:ana'
const FLOW = `flow:${SLUG}`

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "advisor", "control": "user" }],
      "editable": ["advisor"]
    },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve"] },
    { "key": "registrar", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: DANA, scopes: ['org.grants'], resource: 'org' },
  { principal: PRIYA, scopes: ['task.reassign'], resource: FLOW },
  { principal: SAM, scopes: ['instance.start'], resource: FLOW },
]

function deps(id: string, at: number): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/** The directory of the run: the release server's resolver over the log's deprovisions. */
function directory(log: Log) {
  const gone = deprovisionedOf(log)
  return resolverFor(
    SAM,
    { advisor: OKAFOR },
    new Map([['registrar-office', [LEE, ANA]]]),
    new Map(),
    { provisioned: (principal) => !gone.has(principal) }
  )
}

/** The log with version 1 published. */
function publishedState(): State {
  const pushed = push(createFlow(SLUG), definition, deps('push', 1), DANA)
  const released = publish(pushed.flow, deps('publish', 2), DANA)
  return apply(released.operation, apply(pushed.operation, emptyState))
}

/** Sam's request submitted and routed to Dr. Okafor, who claims it. */
function claimedState(): State {
  let state = publishedState()
  const resolve = directory(state.log)
  const flow = { slug: SLUG, versions: [{ version: 1, contentHash: '', definition }] }
  const started = startInstance(
    { ...flow, versions: [instanceVersion(state)] },
    'inst-1',
    { advisor: OKAFOR },
    SAM,
    deps('op-1', 3),
    resolve,
    grants
  )
  state = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants, owner: PRIYA },
    deps('op-2', 4)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const current = instanceOf(state.log, 'inst-1')
  if (current === undefined) throw new Error('not projected')
  const claimed = claim(current, OKAFOR, current.version ?? 0, deps('op-3', 5))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  return apply(claimed.operation, state)
}

/** The published version as the log records it, so a start pins the right hash (DF-2). */
function instanceVersion(state: State) {
  const published = state.log.find((event) => event.type === 'config.definition.published@1')
  if (published === undefined) throw new Error('not published')
  return { version: 1, contentHash: String(published.payload.contentHash), definition }
}

test.fails('#267 ID-5 a deprovision releases each held task with the reason and records the account', () => {
  let state = claimedState()
  const held = instanceOf(state.log, 'inst-1')
  if (held === undefined) throw new Error('not projected')
  expect(held.holder).toBe(OKAFOR)

  // Dana, who holds org.grants, deprovisions Dr. Okafor once the directory no
  // longer holds him (ID-5). The engine refuses an actor without the scope.
  const gone = () => []
  const refused = deprovision(OKAFOR, gone, [held], deps('op-4', 6), { actor: SAM, grants: [] })
  expect(refused.accepted).toBe(false)
  expect(refused.reason).toContain('org.grants')

  const result = deprovision(OKAFOR, gone, [held], deps('op-4', 6), { actor: DANA, grants })
  expect(result.accepted).toBe(true)
  if (result.operation === undefined) throw new Error(result.reason)
  // One release per held task, through the release event with the reason
  // (WF-5, I14), attributed to Dana.
  expect(result.releases).toHaveLength(1)
  expect(result.releases[0]).toMatchObject({
    type: TASK_RELEASED,
    actor: DANA,
    payload: {
      instanceId: 'inst-1',
      step: 'advisor',
      holder: OKAFOR,
      reason: `${OKAFOR} was deprovisioned`,
    },
  })
  // The account record names the released tasks (I14).
  expect(result.operation).toMatchObject({
    type: USER_DEPROVISIONED,
    actor: DANA,
    payload: { principal: OKAFOR, released: [{ instanceId: 'inst-1', step: 'advisor' }] },
  })
  // The ids are distinct, so the log keeps every event (I1).
  const ids = new Set([...result.releases, result.operation].map((operation) => operation.id))
  expect(ids.size).toBe(2)

  for (const operation of [...result.releases, result.operation]) state = apply(operation, state)
  // The projection folds the release: the task is back in the pool (A1), the
  // version advanced (I5), and the timeline carries the release with its reason.
  const pooled = instanceOf(state.log, 'inst-1')
  expect(pooled?.holder).toBeUndefined()
  expect(pooled?.currentStep).toBe('advisor')
  expect(pooled?.version).toBe((held.version ?? 0) + 1)
  const entry = timeline(state.log).find((candidate) => candidate.type === TASK_RELEASED)
  expect(entry).toMatchObject({
    actor: DANA,
    step: 'advisor',
    reason: `${OKAFOR} was deprovisioned`,
  })

  // The log now says who is deprovisioned (ID-5), and a provision clears it.
  expect([...deprovisionedOf(state.log)]).toEqual([OKAFOR])
  state = apply(
    {
      id: 'op-6',
      type: USER_PROVISIONED,
      at: 7,
      actor: DIRECTORY_ACTOR,
      payload: { principal: OKAFOR },
    },
    state
  )
  expect(deprovisionedOf(state.log).size).toBe(0)

  // The directory itself needs no grant: a scheduled sync deprovisions as the directory.
  const bySync = deprovision(OKAFOR, gone, [], deps('op-7', 8))
  expect(bySync.accepted).toBe(true)
  expect(bySync.operation?.actor).toBe(DIRECTORY_ACTOR)
  expect(bySync.releases).toEqual([])
})

test.fails('#267 S08 I10 a target that names a deprovisioned user routes to Unroutable with the owner alert', () => {
  let state = publishedState()
  const gone = deprovision(OKAFOR, () => [], [], deps('op-0', 2), { actor: DANA, grants })
  if (gone.operation === undefined) throw new Error(gone.reason)
  state = apply(gone.operation, state)

  // The shared resolver resolves a user, a field, a starter and a manager
  // that name a deprovisioned person to nobody, and keeps everyone else.
  const resolve = directory(state.log)
  expect(resolve({ field: 'advisor' })).toEqual([])
  expect(resolve({ user: OKAFOR })).toEqual([])
  expect(resolve({ starter: 'starter' })).toEqual([SAM])
  expect(resolve({ team: 'registrar-office' })).toEqual([LEE, ANA])
  expect(
    resolverFor(OKAFOR, {}, new Map(), new Map(), {
      provisioned: (principal) => principal !== OKAFOR,
      managerOf: () => OKAFOR,
    })({ 'manager-of': 'starter' })
  ).toEqual([])
  expect(
    resolverFor(SAM, {}, new Map(), new Map(), {
      managerOf: (starter) => (starter === SAM ? LEE : undefined),
    })({ 'manager-of': 'starter' })
  ).toEqual([LEE])

  // Sam's submit routes the advisor step, whose field names Dr. Okafor: the
  // task goes to the Unroutable queue and Priya, the owner, gets the alert
  // in the same operation (I10, I2, S08).
  const started = startInstance(
    { slug: SLUG, versions: [instanceVersion(state)] },
    'inst-1',
    { advisor: OKAFOR },
    SAM,
    deps('op-1', 3),
    resolve,
    grants
  )
  state = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants, owner: PRIYA },
    deps('op-2', 4)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const instance = instanceOf(state.log, 'inst-1')
  expect(instance?.currentStep).toBe('advisor')
  expect(instance?.queue).toBe(UNROUTABLE_QUEUE)
  expect(instance?.assignees).toContainEqual({
    step: 'advisor',
    target: { field: 'advisor' },
    members: [],
  })
  expect(outboxOf(state.log)).toContainEqual({
    operation: UNROUTABLE_ALERT,
    target: ALERT_CONNECTOR,
    payload: { to: PRIYA, step: 'advisor' },
  })
})
