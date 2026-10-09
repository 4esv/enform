import { expect, test } from 'vitest'
import type { State } from '../../engine/apply.js'
import { serialize } from '../../engine/definition.js'
import { createFlow, publish, push, validate } from '../../engine/flow.js'
import { contentHash, createInstance } from '../../engine/instance.js'
import type { Operation } from '../../engine/operation.js'
import { DUPLICATE, runOperator } from '../../tools/harness/operators.js'
import { oracles } from '../../tools/harness/oracles.js'
import { runGolden } from '../../tools/harness/runner.js'
import { goldenView, stepOperation } from '../../tools/harness/scenario.js'
import { draftV1, draftV2, golden } from './scenario.js'

// The injected sources of the lifecycle in the golden path (I6): the clock is
// the step index and the IDs are `op-N`, exactly as `stepOperation` builds
// them, so the lifecycle operations equal the scenario's.
function stepDeps(index: number): { clock: () => number; ids: () => string } {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

// The golden path through the flow lifecycle (DF-1, DF-2, DF-4): push the
// first draft, publish version 1, then push a change. It returns the
// operations that the steps record.
function lifecycleOperations(): readonly Operation[] {
  let flow = createFlow('course-overload')
  const operations: Operation[] = []
  const first = push(flow, draftV1, stepDeps(0), 'dana')
  flow = first.flow
  operations.push(first.operation)
  const published = publish(flow, stepDeps(1), 'dana')
  flow = published.flow
  operations.push(published.operation)
  const changed = push(flow, draftV2, stepDeps(2), 'dana')
  operations.push(changed.operation)
  return operations
}

// Issue #38: the flow lifecycle. A push makes the draft equal to the file
// (DF-4), a publish freezes the draft as version 1 with a content hash (DF-2),
// and a later push opens a new draft while an instance stays on version 1
// (DF-2, I13). The scenario is this lifecycle: its operations are the golden
// path. The first check is marked expected to fail until the lifecycle is
// implemented.

test('#38 the lifecycle publishes an immutable version and pins an instance to version 1 (S01)', () => {
  // The lifecycle produces the golden path, operation for operation.
  expect(lifecycleOperations()).toEqual(
    golden.steps.map((step, index) => stepOperation(step, index))
  )

  // A push makes the draft equal to the pushed file, and validate reads a file
  // without changing the flow (DF-1, DF-4).
  let flow = createFlow('course-overload')
  const first = push(flow, draftV1, stepDeps(0), 'dana')
  flow = first.flow
  expect(flow.draft).toEqual(draftV1)
  expect(validate(serialize(draftV1))).toEqual(draftV1)
  expect(() => validate('{ "schemaVersion": 2, "steps": [] }')).toThrow(/schemaVersion/)

  // Publish freezes the draft as version 1 with a content hash (DF-2).
  const published = publish(flow, stepDeps(1), 'dana')
  flow = published.flow
  expect(flow.versions).toHaveLength(1)
  expect(flow.versions[0].version).toBe(1)
  expect(flow.versions[0].contentHash).toBe(contentHash(draftV1))

  // An instance created from version 1 stays on it (I13).
  const version1 = flow.versions[0]
  const instance = createInstance(version1.definition, [])

  // A push after publish opens a new draft; version 1 does not change (DF-2).
  const changed = push(flow, draftV2, stepDeps(2), 'dana')
  flow = changed.flow
  expect(flow.draft).toEqual(draftV2)
  expect(flow.versions).toEqual([version1])
  expect(instance.definitionVersion).toBe(version1.contentHash)
})

// Issue #24: the golden-path runner executes a scenario in api mode and the
// end state equals the golden end state. The first check is marked expected
// to fail until the runner is implemented.

test('#24 the api-mode runner reaches the golden end state (S01)', async () => {
  await runGolden(golden)
  expect(goldenView(golden).log).toHaveLength(3)
})

// Issue #28: the oracle pipeline checks every run in the order of #28, so all
// invariants, then the golden end state, then the timeline. This run is the
// golden run with the actor stripped from its behavior events, a violation
// of I14. The pipeline must reject it. The check is marked expected to fail
// until the pipeline is implemented.

test('#28 the oracles fail a run whose behavior event has no actor', () => {
  const expected = goldenView(golden)
  const unattributed: State = {
    applied: new Set(expected.applied),
    log: expected.log.map((event) => ({ ...event, actor: undefined })),
  }
  expect(() => oracles(unattributed, golden)).toThrow()
})

// Issue #31: the Duplicate operator sends each operation two times, and the
// end state does not change (I1, I3). The check is marked expected to fail
// until the operator is implemented.

test('#31 the Duplicate operator leaves the end state unchanged (S01)', async () => {
  await runOperator(golden, DUPLICATE)
  expect(goldenView(golden).log).toHaveLength(3)
})
