import { expect, test } from 'vitest'
import { claim, complete } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import { REMINDER_EMAIL, TIMER_FIRED } from '../engine/reminders.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { CONNECTOR_CALLED, timeline } from '../engine/timeline.js'
import { SENT_OUTCOME, undoAction } from '../engine/undo.js'

// Issue #269, VT-2, VT-3, VT-4, WF-5, S12, S14, S16, A4, I4, I8: what the
// instance read tells a page so the page decides nothing (A9). The view says
// whether the actor may release or reassign the task, names the one action
// the actor may undo now and until when, the tracker carries the reminder
// and the escalation that fired for a step, the timeline marks an undone
// event and the side effects an undo could not reverse, and a private draft
// answers its activity without its contents (VT-4, D1).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'
const LEE = 'user:lee'
const ANA = 'user:ana'
const PRIYA = 'user:priya'
const FLOW = `flow:${SLUG}`

const definition = parse(`{
  "schemaVersion": 2,
  "undoHours": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "editable": ["summary"]
    },
    {
      "key": "advisor",
      "targets": [{ "user": "${OKAFOR}" }],
      "outcomes": ["approve"],
      "reminderMinutes": 60,
      "deadlineMinutes": 180
    },
    {
      "key": "registrar",
      "targets": [{ "team": "registrar-office" }],
      "outcomes": ["approve"]
    }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: FLOW },
  { principal: OKAFOR, scopes: ['step.outcome:approve'], resource: `${FLOW}/step:advisor` },
  { principal: PRIYA, scopes: ['task.reassign', 'instance.read'], resource: FLOW },
]
const grantsOf = (person: string): readonly Grant[] =>
  grants.filter((grant) => grant.principal === person)

const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('user' in target) return [target.user]
  if ('team' in target) return [LEE, ANA]
  return []
}

const MINUTE = 60_000
const T0 = 1_700_000_000_000
let tick = 0
function deps(at: number): OperationDeps {
  tick += 1
  return { clock: () => at, ids: () => `op-${tick}` }
}

/** The state after Sam submitted and Dr. Okafor claimed, with the request's events in order. */
function claimedState(): State {
  const pushed = push(createFlow(SLUG), definition, deps(T0), 'user:dana')
  const published = publish(pushed.flow, deps(T0), 'user:dana')
  let state = apply(published.operation, apply(pushed.operation, emptyState))
  const started = startInstance(
    published.flow,
    'inst-1',
    { summary: 'three credits' },
    SAM,
    deps(T0 + MINUTE),
    resolve,
    grantsOf(SAM)
  )
  state = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: grantsOf(SAM) },
    deps(T0 + 2 * MINUTE)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('no instance')
  const claimed = claim(instance, OKAFOR, 1, deps(T0 + 3 * MINUTE))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  return apply(claimed.operation, state)
}

/** One field of a value the types do not carry yet (#269): the implementation commit reads it directly. */
function field(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}

function view(state: State, actor: string) {
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('no instance')
  const read = readInstance(
    actor,
    instance,
    { flow: SLUG, definition, log: state.log, grants: grantsOf(actor) },
    resolve
  )
  if (read === undefined) throw new Error(`${actor} may not read`)
  return read
}

test.fails('#269 WF-5 the view says who may release or reassign, and which action the actor may undo until when', () => {
  const state = claimedState()
  const okafor = view(state, OKAFOR)
  const priya = view(state, PRIYA)
  const sam = view(state, SAM)
  // The holder releases, the flow owner releases and reassigns, the starter neither.
  expect(field(okafor, 'canRelease')).toBe(true)
  expect(field(okafor, 'canReassign')).toBe(false)
  expect(field(priya, 'canRelease')).toBe(true)
  expect(field(priya, 'canReassign')).toBe(true)
  expect(field(sam, 'canRelease')).toBe(false)
  expect(field(sam, 'canReassign')).toBe(false)
  // The claim is the latest manual action: its actor and the flow owner may
  // undo it within the flow's two hours (WF-5), the starter may not.
  const claimSeq = state.log[state.log.length - 1].seq
  expect(field(okafor, 'undoable')).toEqual({
    seq: claimSeq,
    type: 'step.claimed@1',
    at: T0 + 3 * MINUTE,
    actor: OKAFOR,
    until: T0 + 3 * MINUTE + 2 * 60 * MINUTE,
  })
  expect(field(field(priya, 'undoable'), 'seq')).toBe(claimSeq)
  expect(field(sam, 'undoable')).toBeUndefined()
})

test.fails('#269 S12 VT-2 the tracker carries the reminder and the escalation that fired for the step', () => {
  let state = claimedState()
  const fired = (kind: 'reminder' | 'escalation', at: number): Operation => ({
    id: `timer-${kind}`,
    type: TIMER_FIRED,
    at,
    payload: {
      timerId: `timer-${kind}`,
      instanceId: 'inst-1',
      step: 'advisor',
      kind,
      fireAt: at,
      outbox: [{ operation: REMINDER_EMAIL, target: 'connector-smtp', payload: { to: OKAFOR } }],
    },
  })
  state = apply(fired('reminder', T0 + 62 * MINUTE), state)
  state = apply(fired('escalation', T0 + 182 * MINUTE), state)
  const advisor = view(state, OKAFOR).tracker.find((step) => step.key === 'advisor')
  expect(advisor?.dueAt).toBe(T0 + 2 * MINUTE + 180 * MINUTE)
  expect(field(advisor, 'reminderSentAt')).toBe(T0 + 62 * MINUTE)
  expect(field(advisor, 'escalatedAt')).toBe(T0 + 182 * MINUTE)
  const request = view(state, OKAFOR).tracker.find((step) => step.key === 'request')
  expect(field(request, 'reminderSentAt')).toBeUndefined()
})

test.fails('#269 S16 the timeline marks an undone event and the side effects the undo could not reverse', () => {
  let state = claimedState()
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('no instance')
  // Dr. Okafor approves: the registrar team is emailed, and the worker
  // records that the email went out (I13).
  const approved = complete(
    instance,
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition, grants: grantsOf(OKAFOR), resolve },
    deps(T0 + 4 * MINUTE)
  )
  if (approved.operation === undefined) throw new Error(approved.reason)
  state = apply(approved.operation, state)
  const approveSeq = state.log[state.log.length - 1].seq
  state = apply(
    {
      id: 'call-1',
      type: CONNECTOR_CALLED,
      at: T0 + 5 * MINUTE,
      actor: 'system',
      payload: {
        instanceId: 'inst-1',
        operation: 'send-assignment',
        time: T0 + 5 * MINUTE,
        outcome: SENT_OUTCOME,
      },
    },
    state
  )
  const before = view(state, OKAFOR)
  expect(field(field(before, 'undoable'), 'seq')).toBe(approveSeq)
  const undone = undoAction(
    instanceOf(state.log, 'inst-1') as NonNullable<ReturnType<typeof instanceOf>>,
    OKAFOR,
    approveSeq,
    'Approved the wrong request',
    3,
    {
      flow: SLUG,
      definition,
      log: state.log,
      grants: grantsOf(OKAFOR),
      now: T0 + 6 * MINUTE,
      undoPeriod: 2 * 60 * MINUTE,
    },
    deps(T0 + 6 * MINUTE)
  )
  if (undone.operation === undefined) throw new Error(undone.reason)
  state = apply(undone.operation, state)
  const entries = timeline(state.log)
  const approval = entries.find((entry) => entry.seq === approveSeq)
  expect(field(approval, 'undone')).toBe(true)
  const compensating = entries[entries.length - 1]
  expect(compensating.type).toBe('event.undone@1')
  expect(field(compensating, 'undoes')).toBe(approveSeq)
  expect(field(compensating, 'alreadySent')).toEqual([
    expect.objectContaining({ operation: 'send-assignment', status: 'Already sent' }),
  ])
  // After the undo, the claim is the latest standing action again.
  const after = view(state, OKAFOR)
  expect(field(field(after, 'undoable'), 'type')).toBe('step.claimed@1')
})

test.fails('#269 VT-4 D1 a private draft answers its activity to a reader of the flow, never its contents', async () => {
  const instances = (await import('../engine/instances.js')) as Record<string, unknown>
  const draftActivity = instances.draftActivity as
    | ((instance: unknown, log: unknown) => unknown)
    | undefined
  if (draftActivity === undefined) throw new Error('#269: draftActivity is not implemented')
  const pushed = push(createFlow(SLUG), definition, deps(T0), 'user:dana')
  const published = publish(pushed.flow, deps(T0), 'user:dana')
  let state = apply(published.operation, apply(pushed.operation, emptyState))
  const started = startInstance(
    published.flow,
    'inst-1',
    { summary: 'private' },
    SAM,
    deps(T0 + MINUTE),
    resolve,
    grantsOf(SAM)
  )
  state = apply(started.operation, state)
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('no instance')
  expect(
    readInstance(PRIYA, instance, {
      flow: SLUG,
      definition,
      log: state.log,
      grants: grantsOf(PRIYA),
    }),
    'the flow owner may not read the draft contents'
  ).toBeUndefined()
  const activity = draftActivity(instance, state.log)
  expect(activity).toEqual({ state: 'draft', starter: SAM, lastActivityAt: T0 + MINUTE })
  expect(JSON.stringify(activity)).not.toContain('private')
})
