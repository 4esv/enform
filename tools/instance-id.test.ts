import { expect, test } from 'vitest'
import { apply, emptyState } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import type { Flow } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance } from '../engine/submission.js'

// Issue #187, DX-1, ADR 0004, ADR 0010, I1, I6, I13, FM-7, S06: the log carries
// the identity of the instance that a change acts on. The client mints the
// instance id, as it mints the operation id (ADR 0004), the start intent
// carries it beside the flow and the values (ADR 0010), and a start records it
// in the instance.started@1 payload and stamps the instance with it, exactly as
// it stamps the starter and the current step. The two ids stay independent: the
// operation id names one change, the instance id names the instance, and the
// step operations that follow name the same instance again.

const SLUG = 'course-overload'
const SAM = 'user:sam'

/** The instance id that the client minted (DX-1, #187). */
const INSTANCE_ID = 'inst-1'

/** The operation id that the injected source returns (I1, I6): not the instance id. */
const OPERATION_ID = 'op-1'

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

const values: ConditionData = { summary: 'hello', urgent: false }

test('#187 a start carries the instance id that the client minted (DX-1)', () => {
  const deps: OperationDeps = { clock: () => 1_700_000_000_000, ids: () => OPERATION_ID }
  const started = startInstance(flow, INSTANCE_ID, values, SAM, deps, resolve, grants)

  // The payload names the instance first, so a reader of the event reads the
  // subject of the change before the change (I4, FM-7, #187).
  expect(Object.keys(started.operation.payload)[0]).toBe('instanceId')
  expect(started.operation.payload.instanceId).toBe(INSTANCE_ID)

  // The returned instance carries the id, exactly as it carries the starter and
  // the current step (I13).
  expect(started.instance.instanceId).toBe(INSTANCE_ID)

  // The instance id does not come from the injected ID source (DX-1, I6): the
  // source gives `op-1` and the caller gives `inst-1`, and they differ.
  expect(started.operation.id).toBe(OPERATION_ID)
  expect(started.operation.payload.instanceId).not.toBe(started.operation.id)

  // A second start with the same instance id names the same instance, a start
  // with another id names another one (I1, DX-1).
  const again = startInstance(flow, INSTANCE_ID, values, SAM, deps, resolve, grants)
  expect(again.operation.payload.instanceId).toBe(INSTANCE_ID)
  const other = startInstance(flow, 'inst-2', values, SAM, deps, resolve, grants)
  expect(other.operation.payload.instanceId).toBe('inst-2')

  // Two starts with the same operation id are one change (I1): the log holds
  // one instance event, exactly as it did before the instance id existed.
  let state = apply(started.operation, emptyState)
  state = apply(again.operation, state)
  expect(state.log).toHaveLength(1)
})
