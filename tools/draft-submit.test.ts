import { expect, test } from 'vitest'
import { claim, complete } from '../engine/action.js'
import { apply, emptyState } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { contentHash, type Instance } from '../engine/instance.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import { outboxOf } from '../engine/outbox.js'
import type { TargetResolver } from '../engine/routing.js'
import { mayRead, status } from '../engine/status.js'
import { startInstance } from '../engine/submission.js'
import { trackerOf } from '../engine/tracker.js'

// Issue #256, ADR 0014, S06, FM-4, FM-7, VT-4, SE-2, D1, I2, I5, I8: a start
// creates a private draft on the request form, the starter edits it, and a
// submit validates the request form, routes and carries the task-assigned
// emails. The checks run the engine functions directly with injected sources
// (I6); the resolver and the projection must agree with them (I4).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'
const LEE = 'user:lee'
const ANA = 'user:ana'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number" },
        { "key": "urgent", "control": "checkbox" }
      ],
      "editable": ["summary", "overload_credits", "urgent"]
    },
    {
      "key": "triage",
      "targets": [{ "group": "CS-Chairs" }],
      "outcomes": ["approve"],
      "skipWhen": { "==": [{ "var": "urgent" }, false] }
    },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] },
    { "key": "registrar", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] }
  ]
}
`)

const flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: OKAFOR, scopes: ['step.outcome:approve'], resource: `flow:${SLUG}/step:advisor` },
]

const resolve: TargetResolver = (target) => {
  if ('user' in target) return [target.user]
  if ('starter' in target) return [SAM]
  if ('team' in target) return [LEE, ANA]
  return []
}

/**
 * The new engine functions, typed loosely until they exist (#256): the test
 * file must type-check while it is an expected failure (MVP.md 11.1).
 */
type DraftFn = (...args: unknown[]) => {
  readonly accepted: boolean
  readonly instance: Instance
  readonly operation?: Operation
  readonly reason?: string
  readonly errors?: unknown
}

async function draftModule(): Promise<{ submitInstance: DraftFn; editDraft: DraftFn }> {
  return (await import('../engine/submission.js')) as unknown as {
    submitInstance: DraftFn
    editDraft: DraftFn
  }
}

function deps(id: string, at = 1): OperationDeps {
  return { clock: () => at, ids: () => id }
}

test.fails('#256 a start is a private draft on the request form (ADR 0014, D1, VT-4)', () => {
  const started = startInstance(
    flow,
    'inst-1',
    { summary: 'three' },
    SAM,
    deps('op-1'),
    resolve,
    grants
  )
  // The draft sits on the request form, the first step, and routes nothing.
  expect(started.instance.currentStep).toBe('request')
  expect(started.instance.submitted).toBe(false)
  expect(started.instance.assignees).toEqual([
    { step: 'request', target: { starter: 'starter' }, members: [SAM] },
  ])
  expect(started.operation.payload.skipped).toEqual([])
  expect(started.operation.payload.outbox).toBeUndefined()
  const state = apply(started.operation, emptyState)
  const projected = instanceOf(state.log, 'inst-1')
  if (projected === undefined) throw new Error('the draft is not on the log')
  const context = { flow: SLUG, definition, log: state.log, grants }
  // Only the starter reads a draft (D1): an assignee of a later step and a
  // principal with instance.read see nothing until the submit.
  expect(mayRead(SAM, projected, context)).toBe(true)
  expect(mayRead(OKAFOR, projected, context)).toBe(false)
  expect(
    mayRead(LEE, projected, {
      ...context,
      grants: [{ principal: LEE, scopes: ['instance.read'], resource: `flow:${SLUG}` }],
    })
  ).toBe(false)
  expect(status(projected, definition, state.log).state).toBe('draft')
  expect(trackerOf(projected, definition, state.log).map((step) => step.state)).toEqual([
    'unopened',
    'not-reached',
    'not-reached',
    'not-reached',
  ])
  // The starter's view is the request form, every field editable (FM-3).
  const view = readInstance(SAM, projected, context)
  expect(view?.editable).toEqual(['summary', 'overload_credits', 'urgent'])
  expect(view?.outcomes).toEqual([])
  // Nobody claims a draft (ADR 0014).
  const claimed = claim(projected, SAM, 0, deps('op-x'))
  expect(claimed.accepted).toBe(false)
  expect(claimed.reason).toContain('draft')
})

test.fails('#256 the starter edits a draft and nobody else does (RT-3, D1)', async () => {
  const { editDraft } = await draftModule()
  const started = startInstance(
    flow,
    'inst-1',
    { summary: 'three' },
    SAM,
    deps('op-1'),
    resolve,
    grants
  )
  const edited = editDraft(started.instance, SAM, { overload_credits: 3 }, deps('op-2', 2))
  expect(edited.accepted).toBe(true)
  expect(edited.operation?.type).toBe('draft.edited@1')
  expect(edited.operation?.payload).toEqual({
    instanceId: 'inst-1',
    values: { overload_credits: 3 },
  })
  expect(edited.instance.values).toEqual({ summary: 'three', overload_credits: 3 })
  const other = editDraft(started.instance, OKAFOR, { summary: 'mine' }, deps('op-3', 3))
  expect(other.accepted).toBe(false)
  expect(other.reason).toContain('starter')
  // The projection folds the edit (I4).
  const state = apply(edited.operation ?? started.operation, apply(started.operation, emptyState))
  expect(instanceOf(state.log, 'inst-1')?.values).toEqual({ summary: 'three', overload_credits: 3 })
})

test.fails('#256 a submit validates the request form, routes and notifies the assignees (FM-4, SE-2, I2)', async () => {
  const { submitInstance } = await draftModule()
  const started = startInstance(flow, 'inst-1', {}, SAM, deps('op-1'), resolve, grants)
  const context = { flow: SLUG, definition, resolve, grants }
  // The required summary is empty: the submit is refused with the error by path (FM-4).
  const refused = submitInstance(
    started.instance,
    SAM,
    { urgent: false },
    0,
    context,
    deps('op-2', 2)
  )
  expect(refused.accepted).toBe(false)
  expect(refused.errors).toEqual([{ path: 'summary', message: 'is required' }])
  // A field the request form does not make editable is refused by name (FM-3).
  const locked = submitInstance(
    started.instance,
    SAM,
    { summary: 'three', advisor_note: 'x' },
    0,
    context,
    deps('op-2', 2)
  )
  expect(locked.accepted).toBe(false)
  expect(locked.reason).toContain('advisor_note')
  // Only the starter submits, and only once (ADR 0014).
  expect(
    submitInstance(started.instance, OKAFOR, { summary: 's' }, 0, context, deps('op-2', 2)).accepted
  ).toBe(false)
  // A stale view is refused (I5).
  expect(
    submitInstance(started.instance, SAM, { summary: 's' }, 4, context, deps('op-2', 2)).accepted
  ).toBe(false)

  const submitted = submitInstance(
    started.instance,
    SAM,
    { summary: 'three', overload_credits: 3, urgent: false },
    0,
    context,
    deps('op-2', 2)
  )
  expect(submitted.accepted).toBe(true)
  const operation = submitted.operation
  if (operation === undefined) throw new Error('no operation')
  // The request form is completed, triage is skipped by the data, and the
  // instance waits at advisor with Okafor as its assignee (WF-1, S05, I13).
  expect(operation.type).toBe('instance.submitted@1')
  expect(operation.payload).toMatchObject({
    instanceId: 'inst-1',
    step: 'request',
    currentStep: 'advisor',
    submitted: true,
    values: { summary: 'three', overload_credits: 3, urgent: false },
    skipped: [{ step: 'triage', condition: { '==': [{ var: 'urgent' }, false] } }],
    assignees: [{ step: 'advisor', target: { user: OKAFOR }, members: [OKAFOR] }],
  })
  expect(submitted.instance.submitted).toBe(true)
  expect(submitted.instance.currentStep).toBe('advisor')
  expect(submitted.instance.version).toBe(1)
  const state = apply(operation, apply(started.operation, emptyState))
  // The task-assigned email rides in the same operation (I2, SE-2).
  expect(outboxOf(state.log)).toEqual([
    {
      operation: 'send-assignment',
      target: 'connector-smtp',
      payload: { to: OKAFOR, step: 'advisor' },
    },
  ])
  // The projection, the status and the tracker agree with the write (I4).
  const projected = instanceOf(state.log, 'inst-1')
  if (projected === undefined) throw new Error('not projected')
  expect(projected.currentStep).toBe('advisor')
  expect(projected.submitted).toBe(true)
  expect(projected.version).toBe(1)
  expect(status(projected, definition, state.log)).toMatchObject({
    state: 'waiting',
    step: 3,
    skipped: [{ step: 'triage' }],
  })
  expect(trackerOf(projected, definition, state.log).map((step) => step.state)).toEqual([
    'completed',
    'skipped',
    'unopened',
    'not-reached',
  ])
  // Okafor reads the submitted instance now (I8), and a second submit is refused.
  const context2 = { flow: SLUG, definition, log: state.log, grants }
  expect(mayRead(OKAFOR, projected, context2)).toBe(true)
  expect(submitInstance(projected, SAM, {}, 1, context, deps('op-3', 3)).accepted).toBe(false)

  // Okafor claims and approves; the completion notifies the registrar team,
  // one email per member (SE-2).
  const claimed = claim(projected, OKAFOR, 1, deps('op-3', 3))
  expect(claimed.accepted).toBe(true)
  const approved = complete(
    claimed.instance,
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition, grants, resolve },
    deps('op-4', 4)
  )
  expect(approved.accepted).toBe(true)
  const after = apply(approved.operation ?? operation, apply(claimed.operation ?? operation, state))
  expect(outboxOf(after.log).slice(1)).toEqual([
    {
      operation: 'send-assignment',
      target: 'connector-smtp',
      payload: { to: LEE, step: 'registrar' },
    },
    {
      operation: 'send-assignment',
      target: 'connector-smtp',
      payload: { to: ANA, step: 'registrar' },
    },
  ])
})

test.fails('#256 a submit of a one-step flow finishes the instance (WF-1)', async () => {
  const { submitInstance } = await draftModule()
  const single = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "editable": ["summary"]
    }
  ]
}
`)
  const oneStep = {
    slug: SLUG,
    versions: [{ version: 1, contentHash: contentHash(single), definition: single }],
  }
  const started = startInstance(oneStep, 'inst-2', {}, SAM, deps('op-1'), resolve, grants)
  const submitted = submitInstance(
    started.instance,
    SAM,
    { summary: 'done' },
    0,
    { flow: SLUG, definition: single, resolve, grants },
    deps('op-2', 2)
  )
  expect(submitted.accepted).toBe(true)
  expect(submitted.instance.done).toBe(true)
  expect(submitted.instance.currentStep).toBeUndefined()
  expect(submitted.operation?.payload.outbox).toBeUndefined()
})
