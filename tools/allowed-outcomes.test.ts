import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #264, S02, AC-4, I8, A9: the instance read names the outcomes the
// acting principal may choose beside the outcomes the step declares. A
// `step.outcome:<name>` scope on the step, or on the flow, allows that
// outcome and no other (AC-4), so Jordan, who holds only `send_back` on the
// registrar step, is offered Send back alone, and the page shows no control
// the engine would refuse. The engine decides; the view only carries it.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const JORDAN = 'user:jordan'
const LEE = 'user:lee'
const INSTANCE_ID = 'inst-1'

const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text", "label": "Summary" }],
      "outcomes": ["submit"]
    },
    {
      "key": "registrar",
      "targets": [{ "user": "user:jordan" }, { "user": "user:lee" }],
      "outcomes": ["approve", "reject", "send_back"]
    }
  ]
}`)

const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('user' in target) return [target.user]
  return []
}

const samGrants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
]
const jordanGrants: readonly Grant[] = [
  {
    principal: JORDAN,
    scopes: ['step.outcome:send_back'],
    resource: `flow:${SLUG}/step:registrar`,
  },
]
const leeGrants: readonly Grant[] = [
  {
    principal: LEE,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: `flow:${SLUG}`,
  },
]

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

/** The log with version 1 published and Sam's request submitted to the registrar step. */
function submitted(): State {
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
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the start recorded no instance')
  const sent = submitInstance(
    { ...instance, version: instance.version ?? 0 },
    SAM,
    { summary: 'hello' },
    instance.version ?? 0,
    { flow: SLUG, definition, resolve, grants: samGrants },
    sources
  )
  if (sent.operation === undefined) throw new Error(sent.reason)
  return apply(sent.operation, state)
}

test('#264 S02 AC-4 the read names the outcomes the actor may choose, and only those', () => {
  const state = submitted()
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the log holds no instance')
  const context = (grants: readonly Grant[]) => ({ flow: SLUG, definition, log: state.log, grants })
  const jordan = readInstance(JORDAN, instance, context(jordanGrants), resolve)
  expect(jordan?.outcomes).toEqual(['approve', 'reject', 'send_back'])
  expect(jordan?.allowedOutcomes).toEqual(['send_back'])
  // A grant on the flow covers its steps (MVP.md 5.6).
  const lee = readInstance(LEE, instance, context(leeGrants), resolve)
  expect(lee?.allowedOutcomes).toEqual(['approve', 'reject'])
  // The starter reads the instance but may choose no outcome of the registrar step.
  const sam = readInstance(SAM, instance, context(samGrants), resolve)
  expect(sam?.outcomes).toEqual(['approve', 'reject', 'send_back'])
  expect(sam?.allowedOutcomes).toEqual([])
})
