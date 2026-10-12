import { expect, test } from 'vitest'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import type { Flow } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #177, FM-7, FM-1, DF-1, I2, A3, A7: the engine records the values that
// a form holds. A start records the values of the step that it routes to, a
// step completion records the values that the step captured, and the values
// are read back through the public API only (A3). The start keeps the routing
// that WF-1 defines, and the submit keeps the outbox entry in the same
// operation (I2).

const SLUG = 'course-overload'
const SAM = 'user:sam'

const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }]
    }
  ]
}
`)

const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

const resolve: TargetResolver = (target) => ('starter' in target ? [SAM] : [])

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
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

const startedValues: ConditionData = { summary: 'hello', urgent: false }
const captured: ConditionData = { summary: 'hello', detail: 'more detail' }

/** The instance id that the start mints (DX-1, #187): deterministic, like every injected source (I6). */
const INSTANCE_ID = 'inst-1'

test('#177 FM-7 a start and a submit carry the values that the form holds', () => {
  const started = startInstance(flow, INSTANCE_ID, startedValues, SAM, deps(), resolve, grants)

  // A start records the values of the step that it routes to (FM-7): the
  // returned instance holds them, and the operation payload carries them.
  expect(started.instance.values).toEqual(startedValues)
  expect(started.operation.payload.values).toEqual(startedValues)

  // The routing is unchanged: the start still routes to the request step and
  // records its resolved assignees (WF-1, I13).
  expect(started.instance.currentStep).toBe('request')
  expect(started.instance.assignees).toEqual([
    { step: 'request', target: { starter: 'starter' }, members: [SAM] },
  ])

  // A step completion records the values that the step captured (FM-7): the
  // submit payload carries them merged over what the instance already held,
  // and the returned instance holds the merge.
  const submitted = submitInstance(started.instance, SAM, deps(), captured)
  expect(submitted.instance.values).toEqual({
    summary: 'hello',
    urgent: false,
    detail: 'more detail',
  })
  expect(submitted.operation.payload.values).toEqual({
    summary: 'hello',
    urgent: false,
    detail: 'more detail',
  })
  expect(submitted.instance.submitted).toBe(true)
})
