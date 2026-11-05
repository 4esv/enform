import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import { createOperation, type OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { status } from '../engine/status.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { runFlow, STEP_SKIPPED } from '../engine/workflow.js'

// Issue #192, WF-1, VT-2, S05, S14, I4, I6, I7: the instance path records the
// steps that its route skipped. A submit routes past a step whose skip
// condition is true (ADR 0014), and the instance.submitted@1 payload carries
// the skipped steps with the condition that skipped each, attributed to the
// starter (WF-1, S05).
// A status read then reads the skips of that instance's own events and nothing
// else, so another instance's skip and a draft run's step.skipped@1 event (which
// carries no instance id) are absent (I4, S14). The dry run over a draft keeps
// its current behaviour (I7).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const LIN = 'user:lin'

/** The instance ids that the two starts mint (DX-1, #187): deterministic, like every source (I6). */
const INSTANCE_ID = 'inst-1'
const OTHER_ID = 'inst-2'

/** The skip condition of the conditional second step (WF-1, S05): a small overload skips the chair. */
const chairSkipWhen = { '<=': [{ var: 'overload_credits' }, 2] }

/** The condition of the draft-run skip that carries no instance id (I4, S05). */
const draftSkipWhen = { '==': [{ var: 'urgent' }, true] }

const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }]
    },
    {
      "key": "chair",
      "targets": [{ "group": "CS-Chairs" }],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    },
    {
      "key": "advisor",
      "targets": [{ "group": "CS-Chairs" }]
    }
  ]
}
`)

const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

/** The directory of the test (AS-1): a group resolves to Dr. Lin, a starter target to Sam. */
const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('group' in target) return [LIN]
  return []
}

/** Sam's grants (AC-1): he may start the flow. */
const samGrants: readonly Grant[] = [
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

/** Start a draft with the overload credits and submit it (ADR 0014); the submit decides the route. */
function startAndSubmit(
  state: State,
  instanceId: string,
  credits: number,
  sources: OperationDeps
): { state: State; skipped: unknown; currentStep: string | undefined } {
  const started = startInstance(
    flow,
    instanceId,
    { overload_credits: credits },
    SAM,
    sources,
    resolve,
    samGrants
  )
  expect(started.operation.payload.skipped, 'a start skips nothing').toEqual([])
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: samGrants },
    sources
  )
  if (!submitted.accepted || submitted.operation === undefined) throw new Error(submitted.reason)
  return {
    state: apply(submitted.operation, apply(started.operation, state)),
    skipped: submitted.operation.payload.skipped,
    currentStep: submitted.instance.currentStep,
  }
}

/** A log with the definition published (DF-2), so the projection can pin the instance to it. */
function seeded(sources: OperationDeps): State {
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

test('#192 a submit records the step its route skipped, and the read reports it (WF-1, S05, I4)', () => {
  const sources = deps()

  // For two overload credits the chair step is skipped, so the submit routes
  // to the advisor step and records the skip on its own operation (WF-1,
  // #192, ADR 0014).
  const submitted = startAndSubmit(seeded(sources), INSTANCE_ID, 2, sources)
  const state = submitted.state
  expect(submitted.currentStep).toBe('advisor')
  expect(submitted.skipped).toEqual([{ step: 'chair', condition: chairSkipWhen }])

  // The read projects the instance from the log and reports the same skip,
  // attributed to this instance (I4, S14).
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error(`the log holds no instance ${INSTANCE_ID}`)
  const view = readInstance(
    SAM,
    instance,
    { flow: SLUG, definition, log: state.log, grants: samGrants },
    resolve
  )
  expect(view?.status.skipped).toEqual([{ step: 'chair', condition: chairSkipWhen }])
})

test('#192 a status read holds only its own instance skips (I4, S05)', () => {
  const sources = deps()
  let state = seeded(sources)

  // Two submissions on one log: the first skips the chair, the second does not.
  const first = startAndSubmit(state, INSTANCE_ID, 2, sources)
  state = first.state
  const second = startAndSubmit(state, OTHER_ID, 4, sources)
  state = second.state
  expect(first.currentStep).toBe('advisor')
  expect(second.currentStep).toBe('chair')

  // A draft run records step.skipped@1 without an instance id (S05, I7). It
  // belongs to no instance, so neither read reports it.
  const draftSkip = createOperation(
    STEP_SKIPPED,
    { step: 'advisor', condition: draftSkipWhen },
    sources,
    SAM
  )
  state = apply(draftSkip, state)

  const one = instanceOf(state.log, INSTANCE_ID)
  const two = instanceOf(state.log, OTHER_ID)
  if (one === undefined || two === undefined) throw new Error('the log holds no started instance')
  expect(status(one, definition, state.log).skipped).toEqual([
    { step: 'chair', condition: chairSkipWhen },
  ])
  expect(status(two, definition, state.log).skipped).toEqual([])
})

test('#192 a dry run and a live run decide the same route, and only the live run writes the skip (I7)', () => {
  // One run path serves both modes (I7): the same definition and data give the
  // same route, and only the side-effect sink differs.
  const dry = runFlow(definition, { overload_credits: 2 }, { ...deps(), sink: 'dry' }, SAM)
  const live = runFlow(definition, { overload_credits: 2 }, { ...deps(), sink: 'live' }, SAM)
  expect(dry.route).toEqual(live.route)
  expect(dry.route).toEqual({
    active: ['request', 'advisor'],
    skipped: [{ step: 'chair', condition: chairSkipWhen }],
  })

  // The dry run writes no event, and the live run writes exactly one
  // step.skipped@1 with the condition and no instance id (S05).
  expect(dry.state.log).toHaveLength(0)
  const skips = live.state.log.filter((event) => event.type === STEP_SKIPPED)
  expect(skips).toHaveLength(1)
  expect(skips[0].payload).toMatchObject({ step: 'chair', condition: chairSkipWhen })
  expect(skips[0].payload.instanceId).toBeUndefined()
})
