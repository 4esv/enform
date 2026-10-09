import { expect, test } from 'vitest'
import { createFlow, publish, push } from '../../engine/flow.js'
import { createInstance } from '../../engine/instance.js'
import { migrateDraft, versionDiff } from '../../engine/version.js'
import { runGolden } from '../../tools/harness/runner.js'
import { stepOperation } from '../../tools/harness/scenario.js'
import { draftV1, draftV2, golden, SLUG } from './scenario.js'

// The injected sources of the golden path (I6): the clock is the step index
// and the IDs are `op-N`, exactly as `stepOperation` builds them, so the
// lifecycle operations equal the scenario's.
function stepDeps(index: number): { clock: () => number; ids: () => string } {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

// Issue #41: adding a field while submissions are in progress (S04). A
// publication freezes the draft into an immutable version with a content hash
// (DF-2), so an instance that started on v1 keeps its definitionVersion when v2
// is published (I13). A structural change creates v2 (DF-6), and the difference
// names the change. A draft that is not submitted rebinds to v2 through
// migrateDraft, while the submitted instance stays on v1 (DF-2, DF-6). This
// milestone's definition model has no form fields yet, so a structural change
// (an added step) stands in for the new field; the field and its values arrive
// with FM-1 (issue #74).

test('#41 a published version pins its instance and a draft rebinds to the next one (S04)', async () => {
  // (a) Dana pushes and publishes version 1, then makes a structural change and
  // publishes version 2 (DF-2, DF-6). Each publication freezes the draft as an
  // immutable version, and the two versions have different content hashes.
  let flow = createFlow(SLUG)
  const firstPush = push(flow, draftV1, stepDeps(0), 'dana')
  flow = firstPush.flow
  const firstPublish = publish(flow, stepDeps(1), 'dana')
  flow = firstPublish.flow
  const secondPush = push(flow, draftV2, stepDeps(2), 'dana')
  flow = secondPush.flow
  const secondPublish = publish(flow, stepDeps(3), 'dana')
  flow = secondPublish.flow
  const [v1, v2] = flow.versions
  expect(flow.versions).toHaveLength(2)
  expect([v1.version, v2.version]).toEqual([1, 2])
  expect(v2.contentHash).not.toBe(v1.contentHash)

  // (b) An instance that started on v1 stays on v1 after v2 is published
  // (DF-2, I13): its definitionVersion is the content hash of v1, and the
  // publication does not touch it.
  const submitted = createInstance(v1.definition, [])
  expect(submitted.definitionVersion).toBe(v1.contentHash)
  expect(submitted.definitionVersion).not.toBe(v2.contentHash)

  // (c) A draft that is not submitted rebinds to v2 (DF-6): migrateDraft sets
  // its definitionVersion to the content hash of v2, and its other fields stay.
  const draft = createInstance(v1.definition, [])
  const migrated = migrateDraft(draft, v2)
  expect(migrated.definitionVersion).toBe(v2.contentHash)
  expect(migrated.assignees).toEqual(draft.assignees)
  expect(migrated.connectorCalls).toEqual(draft.connectorCalls)

  // (d) The difference from v1 to v2 names the structural change (DF-6): the
  // added step stands in for the new field.
  expect(versionDiff(v1, v2)).toEqual([
    { class: 'structural', message: 'a step was added: reason_category' },
  ])

  // The lifecycle operations are the golden path, operation for operation, and
  // the api-mode run reaches the golden end state (I6).
  const operations = [
    firstPush.operation,
    firstPublish.operation,
    secondPush.operation,
    secondPublish.operation,
  ]
  expect(operations).toEqual(golden.steps.map((step, index) => stepOperation(step, index)))
  await runGolden(golden)
})
