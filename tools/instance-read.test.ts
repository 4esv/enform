import { expect, test } from 'vitest'
import { claim, complete } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, publish, push } from '../engine/flow.js'
import { contentHash, type Instance } from '../engine/instance.js'
import {
  type InstanceView,
  instanceOf,
  type ProjectedInstance,
  readInstance,
} from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #76, FM-3, FM-7, VT-4, S14, DF-2, DX-1, I4, I6, I8: the instance as a
// step sees it. #187 put the instance id on the log; the projection folds the
// events that name one instance into that instance, and the step-scoped read
// narrows it to the actor and the current step. A field the step does not make
// visible is absent from the values (FM-3 criterion 1), only an assignee of the
// step gets the editable keys, and an actor that may not read the instance reads
// nothing (I8). Events of another instance never affect the result (I4, I6).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const PRISCILLA = 'user:priscilla'
const OUTSIDER = 'user:outsider'

/** The instance id that the start mints (DX-1, #187): deterministic, like every injected source (I6). */
const INSTANCE_ID = 'inst-1'

/** A second instance id, so the projection can prove it never mixes two instances (I4). */
const OTHER_ID = 'inst-2'

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
      "targets": [{ "user": "user:okafor" }],
      "fields": [
        { "key": "summary", "control": "text" },
        { "key": "decision", "control": "select", "options": ["approve", "reject"] }
      ],
      "editable": ["decision"],
      "outcomes": ["approve", "reject"]
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

/** Sam's grants (AC-1, AC-4): he may start the flow and submit the request step. */
const samGrants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
]

/** Priscilla's grant (AC-5): she may read the flow's instances without acting on a step. */
const readerGrants: readonly Grant[] = [
  { principal: PRISCILLA, scopes: ['instance.read'], resource: `flow:${SLUG}` },
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

/** The instance that the projection reads from the log; throws when it is absent. */
function projected(state: State, instanceId = INSTANCE_ID): ProjectedInstance {
  const instance = instanceOf(state.log, instanceId)
  if (instance === undefined) throw new Error(`the log holds no instance ${instanceId}`)
  return instance
}

/** The status context of a read (S14): the flow, the definition, the log and the grants that apply. */
function context(state: State, grants: readonly Grant[]) {
  return { flow: SLUG, definition, log: state.log, grants }
}

test.fails('#76 FM-3 a step read hides a field it does not make visible (FM-3, I8)', () => {
  const sources = deps()
  let state = seeded(sources)
  const started = startInstance(
    flow,
    INSTANCE_ID,
    { summary: 'hello', detail: 'private' },
    SAM,
    sources,
    resolve,
    samGrants
  )
  state = apply(started.operation, state)
  const instance = projected(state)

  // The target of the step reads: the step makes `summary` visible and
  // editable and does not make `detail` visible, so `detail` is absent from the
  // values (FM-3 criterion 1). It is absent, not null.
  const view: InstanceView | undefined = readInstance(SAM, instance, context(state, samGrants))
  expect(view?.instanceId).toBe(INSTANCE_ID)
  expect(view?.visible).toEqual(['summary'])
  expect(view?.editable).toEqual(['summary'])
  expect(view?.values).toEqual({ summary: 'hello' })
  expect(Object.hasOwn(view?.values ?? {}, 'detail'), 'a hidden field is absent, not null').toBe(
    false
  )

  // A principal that may read the instance but is not an assignee of the step
  // gets the visible fields and no editable field (FM-3, I8).
  const reader = readInstance(PRISCILLA, instance, context(state, readerGrants))
  expect(reader?.visible).toEqual(['summary'])
  expect(reader?.editable).toEqual([])
  expect(reader?.values).toEqual({ summary: 'hello' })

  // A principal that may not read the instance reads nothing (I8).
  expect(readInstance(OUTSIDER, instance, context(state, []))).toBeUndefined()
})

test.fails('#76 FM-3 the read reflects the instance log, and another instance never leaks (I4, I6)', () => {
  const sources = deps()
  let state = seeded(sources)
  const first = startInstance(
    flow,
    INSTANCE_ID,
    { summary: 'first' },
    SAM,
    sources,
    resolve,
    samGrants
  )
  state = apply(first.operation, state)
  // The version that the first instance's view was read at (I5): the log
  // position just after its start, before the second instance starts.
  const firstView: Instance = { ...first.instance, version: state.log.length }
  const second = startInstance(
    flow,
    OTHER_ID,
    { summary: 'second' },
    SAM,
    sources,
    resolve,
    samGrants
  )
  state = apply(second.operation, state)

  // The first instance advances: a claim and a completion move it to `review`
  // (WF-1), and a submit records the values it captured (FM-7).
  const claimed = claim(firstView, SAM, firstView.version ?? 0, sources)
  expect(claimed.accepted).toBe(true)
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  state = apply(claimed.operation, state)
  const completed = complete(
    claimed.instance,
    SAM,
    'submit',
    claimed.instance.version ?? 0,
    { flow: SLUG, definition, grants: samGrants },
    sources
  )
  expect(completed.accepted).toBe(true)
  if (completed.operation === undefined) throw new Error(completed.reason)
  state = apply(completed.operation, state)
  const submitted = submitInstance(completed.instance, SAM, sources, { decision: 'approve' })
  state = apply(submitted.operation, state)

  // The projection reflects all of it: `review` is the current step, the
  // instance is submitted, and the values are the captured ones merged over
  // what it already held (FM-7).
  const instance = projected(state)
  expect(instance.currentStep).toBe('review')
  expect(instance.submitted).toBe(true)
  expect(instance.values).toEqual({ summary: 'first', decision: 'approve' })

  // `review` declares no `visible`, so every field of the step is visible. The
  // starter may read the instance but is not an assignee of `review`, so it
  // shows no editable field (FM-3).
  const view = readInstance(SAM, instance, context(state, samGrants))
  expect(view?.visible).toEqual(['summary', 'decision'])
  expect(view?.editable).toEqual([])
  expect(view?.values).toEqual({ summary: 'first', decision: 'approve' })

  // The second instance never saw the first instance's events (I4, I6).
  const other = projected(state, OTHER_ID)
  expect(other.currentStep).toBe('request')
  expect(other.submitted).toBe(false)
  expect(other.holder).toBeUndefined()
  expect(other.values).toEqual({ summary: 'second' })

  // The log holds no instance with an unknown id.
  expect(instanceOf(state.log, 'missing')).toBeUndefined()
})

// A read that the API serves as 404: the log holds the instance but not the
// version it is pinned to, so the projection answers undefined rather than
// guessing a transition (DF-2). The condition is data, not a fixture: a start
// always publishes its version (DF-2), so this is the malformed-log case.
test.fails('#76 an instance whose pinned definition is absent is not projected (DF-2)', () => {
  const sources = deps()
  const started = startInstance(
    flow,
    INSTANCE_ID,
    { summary: 'hello' },
    SAM,
    sources,
    resolve,
    samGrants
  )
  // A log that holds the pinned publication projects the instance...
  expect(instanceOf(apply(started.operation, seeded(sources)).log, INSTANCE_ID)).toBeDefined()
  // ...and a log that holds the instance but not its published version gives
  // undefined, so the fold never guesses a transition (DF-2).
  const orphan = apply(started.operation, emptyState)
  expect(instanceOf(orphan.log, INSTANCE_ID)).toBeUndefined()
})
