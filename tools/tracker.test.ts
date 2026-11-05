// Issue #244, S14, VT-2, WF-1, WF-3, I4, I6: the per-step tracker of an
// instance. The tracker is a projection of the instance, its pinned definition
// and the log: the submit's skip is skipped with its condition (ADR 0014), the
// current step is opened once it has a holder and unopened before, a
// completion keeps the history of an earlier step, a send back marks the
// target step and keeps the comment, and a done instance shows every step
// completed or skipped. Events of another instance never change the tracker
// (I4).

import { expect, test } from 'vitest'
import { claim, complete } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { sendBack } from '../engine/sendBack.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { trackerOf } from '../engine/tracker.js'

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'
const ANA = 'user:ana'
const INSTANCE_ID = 'inst-1'
const OTHER_ID = 'inst-2'
const COMMENT = 'Attach your degree audit'
const T = 1_700_000_000_000

const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }]
    },
    {
      "key": "chair",
      "targets": [{ "starter": "starter" }],
      "outcomes": ["approve"],
      "skipWhen": { "<=": [{ "var": "credits" }, 2] }
    },
    {
      "key": "advisor",
      "targets": [{ "user": "user:okafor" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "registrar",
      "targets": [{ "user": "user:ana" }],
      "outcomes": ["approve"]
    }
  ]
}
`)

const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

/** The directory of the test (AS-1): a starter target resolves to Sam, a user target to itself. */
const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('user' in target) return [target.user]
  return []
}

/** The grants of the cast (AC-1, AC-4): each step's outcome on its own resource. */
const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: OKAFOR, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}/step:advisor` },
  {
    principal: OKAFOR,
    scopes: ['step.outcome:send_back'],
    resource: `flow:${SLUG}/step:advisor`,
  },
  { principal: ANA, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}/step:registrar` },
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

/** A log with the definition published (DF-2), so the projection can pin the instance to it. */
function seeded(sources: OperationDeps): State {
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/** Start one instance and apply its operation. */
function start(state: State, sources: OperationDeps, instanceId = INSTANCE_ID): State {
  const started = startInstance(flow, instanceId, { credits: 2 }, SAM, sources, resolve, grants)
  return apply(started.operation, state)
}

/** Submit the draft (ADR 0014): the request form is completed and the route decided. */
function submit(state: State, sources: OperationDeps, instanceId = INSTANCE_ID): State {
  const instance = instanceAt(state, instanceId)
  const submitted = submitInstance(
    instance,
    SAM,
    {},
    instance.version ?? 0,
    { flow: SLUG, definition, resolve, grants },
    sources
  )
  if (!submitted.accepted || submitted.operation === undefined) throw new Error(submitted.reason)
  return apply(submitted.operation, state)
}

/** The projected instance, or a named failure. */
function instanceAt(state: State, instanceId = INSTANCE_ID) {
  const instance = instanceOf(state.log, instanceId)
  if (instance === undefined) throw new Error(`the log holds no instance ${instanceId}`)
  return instance
}

/** The tracker that the instance read carries (S14, #244). */
function trackerAt(state: State, instanceId = INSTANCE_ID) {
  const view = readInstance(SAM, instanceAt(state, instanceId), {
    flow: SLUG,
    definition,
    log: state.log,
    grants,
  })
  if (view === undefined) throw new Error('the read was refused')
  return view.tracker
}

/** Claim and complete the current step as one actor, then return the new state. */
function act(
  state: State,
  sources: OperationDeps,
  actor: string,
  outcome: string,
  instanceId = INSTANCE_ID
): State {
  const instance = instanceAt(state, instanceId)
  const claimed = claim(instance, actor, instance.version ?? 0, sources)
  if (!claimed.accepted || claimed.operation === undefined) throw new Error(claimed.reason)
  const afterClaim = apply(claimed.operation, state)
  const completed = complete(
    instanceAt(afterClaim, instanceId),
    actor,
    outcome,
    {},
    instanceAt(afterClaim, instanceId).version ?? 0,
    { flow: SLUG, definition, grants, resolve },
    sources
  )
  if (!completed.accepted || completed.operation === undefined) throw new Error(completed.reason)
  return apply(completed.operation, afterClaim)
}

test('#244 VT-2 the tracker shows the submit skip, the current step, a completion and a send back', () => {
  const sources = deps()
  let state = seeded(sources)
  state = start(state, sources)

  // The draft sits on the request form (ADR 0014): `request` waits unopened,
  // and nothing is routed or skipped yet.
  expect(trackerAt(state)).toEqual([
    { key: 'request', state: 'unopened', startAt: 1_700_000_000_000 },
    { key: 'chair', state: 'not-reached' },
    { key: 'advisor', state: 'not-reached' },
    { key: 'registrar', state: 'not-reached' },
  ])

  // The submit completes the request form and routes past the chair, so
  // `chair` is skipped with its condition (S05, WF-1), the advisor waits
  // unopened, and `request` stays as history: completed, not the current
  // step (VT-2).
  state = submit(state, sources)
  expect(trackerAt(state)).toEqual([
    { key: 'request', state: 'completed', startAt: T, lastActivityAt: T },
    { key: 'chair', state: 'skipped', condition: { '<=': [{ var: 'credits' }, 2] } },
    { key: 'advisor', state: 'unopened', startAt: T },
    { key: 'registrar', state: 'not-reached' },
  ])

  // Okafor claims the advisor step and sends it back to `request`. The target
  // is sent back with the comment (WF-3), the step that sent it back keeps its
  // earlier state, and the registrar is not reached.
  const advisor = claim(instanceAt(state), OKAFOR, instanceAt(state).version ?? 0, sources)
  if (!advisor.accepted || advisor.operation === undefined) throw new Error(advisor.reason)
  state = apply(advisor.operation, state)
  const sent = sendBack(
    instanceAt(state),
    OKAFOR,
    'request',
    COMMENT,
    instanceAt(state).version ?? 0,
    { flow: SLUG, definition, grants, resolve },
    sources
  )
  if (!sent.accepted || sent.operation === undefined) throw new Error(sent.reason)
  state = apply(sent.operation, state)
  expect(trackerAt(state)).toEqual([
    { key: 'request', state: 'sent-back', comment: COMMENT, startAt: T, lastActivityAt: T },
    { key: 'chair', state: 'skipped', condition: { '<=': [{ var: 'credits' }, 2] } },
    { key: 'advisor', state: 'opened', startAt: T, lastActivityAt: T },
    { key: 'registrar', state: 'not-reached' },
  ])
})

test('#244 VT-2 a done instance shows every step completed or skipped', () => {
  const sources = deps()
  let state = seeded(sources)
  state = start(state, sources)
  state = submit(state, sources)
  state = act(state, sources, OKAFOR, 'approve')
  state = act(state, sources, ANA, 'approve')

  expect(instanceAt(state).done).toBe(true)
  expect(trackerOf(instanceAt(state), definition, state.log)).toEqual([
    { key: 'request', state: 'completed', startAt: T, lastActivityAt: T },
    { key: 'chair', state: 'skipped', condition: { '<=': [{ var: 'credits' }, 2] } },
    { key: 'advisor', state: 'completed', startAt: T, lastActivityAt: T },
    { key: 'registrar', state: 'completed', startAt: T, lastActivityAt: T },
  ])
})

test('#246 VT-2 the tracker carries the entry time and the last activity from the log', () => {
  // A clock that advances one minute per operation tells the entry time apart
  // from the event that last touched the step (I6).
  const base = 1_700_000_000_000
  let tick = 0
  const sources: OperationDeps = {
    clock: () => base + tick++ * 60_000,
    ids: () => `op-time-${tick}`,
  }
  let state = seeded(sources)
  state = start(state, sources)
  const started = state.log[state.log.length - 1]

  // The request form is entered at the start and has no activity yet.
  expect(trackerAt(state)[0]).toEqual({
    key: 'request',
    state: 'unopened',
    startAt: started.at,
  })

  // The submit is the newest event for the request, and it enters the advisor
  // step, so the advisor starts at the submit's time (ADR 0014).
  state = submit(state, sources)
  const completionEvent = state.log[state.log.length - 1]
  expect(trackerAt(state)[0]).toEqual({
    key: 'request',
    state: 'completed',
    startAt: started.at,
    lastActivityAt: completionEvent.at,
  })
  expect(trackerAt(state)[2]).toEqual({
    key: 'advisor',
    state: 'unopened',
    startAt: completionEvent.at,
  })

  // A send back reopens the request: its entry time is the send back, and the
  // step it left carries the same event as its last activity.
  const advisor = claim(instanceAt(state), OKAFOR, instanceAt(state).version ?? 0, sources)
  if (!advisor.accepted || advisor.operation === undefined) throw new Error(advisor.reason)
  state = apply(advisor.operation, state)
  const sent = sendBack(
    instanceAt(state),
    OKAFOR,
    'request',
    COMMENT,
    instanceAt(state).version ?? 0,
    { flow: SLUG, definition, grants, resolve },
    sources
  )
  if (!sent.accepted || sent.operation === undefined) throw new Error(sent.reason)
  state = apply(sent.operation, state)
  const sendBackEvent = state.log[state.log.length - 1]
  expect(trackerAt(state)[0]).toEqual({
    key: 'request',
    state: 'sent-back',
    comment: COMMENT,
    startAt: sendBackEvent.at,
    lastActivityAt: sendBackEvent.at,
  })
  expect(trackerAt(state)[2]).toEqual({
    key: 'advisor',
    state: 'opened',
    startAt: completionEvent.at,
    lastActivityAt: sendBackEvent.at,
  })
})

test('#244 I4 another instance never changes the tracker', () => {
  const sources = deps()
  let state = seeded(sources)
  state = start(state, sources)
  state = submit(state, sources)
  const before = trackerAt(state)

  // A second instance starts on the same flow and reaches the advisor step. The
  // first instance's events and the second's are told apart by the instance id
  // (I4), so the first tracker is byte for byte the same.
  state = start(state, sources, OTHER_ID)
  state = submit(state, sources, OTHER_ID)
  expect(trackerAt(state)).toEqual(before)
  expect(trackerAt(state, OTHER_ID)[2]).toEqual({
    key: 'advisor',
    state: 'unopened',
    startAt: T,
  })
})

// Issue #248, S12, VT-2, SE-4: a step that sets a deadline carries its due
// time on the tracker, counted from the start of the step. A step without a
// deadline carries none, so the read never invents a due time.
test('#248 VT-2 the tracker carries the step deadline as the due time (SE-4)', () => {
  const definitionWithTimer = parse(`{
    "schemaVersion": 2,
    "steps": [
      { "key": "request", "targets": [{ "starter": "starter" }] },
      {
        "key": "wait",
        "targets": [{ "user": "user:okafor" }],
        "reminderMinutes": 5,
        "deadlineMinutes": 10
      },
      {
        "key": "after",
        "targets": [{ "user": "user:okafor" }]
      }
    ]
  }`)
  const flowWithTimer: Flow = {
    slug: SLUG,
    versions: [
      {
        version: 1,
        contentHash: contentHash(definitionWithTimer),
        definition: definitionWithTimer,
      },
    ],
  }
  const sources = deps()
  const pushed = push(createFlow(SLUG), definitionWithTimer, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  const seededState = apply(published.operation, apply(pushed.operation, emptyState))
  const started = startInstance(flowWithTimer, INSTANCE_ID, {}, SAM, sources, resolve, grants)
  // The submit enters the step with the deadline (ADR 0014), so the due time
  // counts from the submit.
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionWithTimer, resolve, grants },
    sources
  )
  if (!submitted.accepted || submitted.operation === undefined) throw new Error(submitted.reason)
  const state = apply(submitted.operation, apply(started.operation, seededState))
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the log holds no started instance')
  const tracker = trackerOf(instance, definitionWithTimer, state.log)
  expect(tracker[1]).toEqual({
    key: 'wait',
    state: 'unopened',
    startAt: T,
    dueAt: T + 10 * 60_000,
  })
  // The next step is not reached, so it has no start time and no due time.
  expect(tracker[2]).toEqual({ key: 'after', state: 'not-reached' })
})
