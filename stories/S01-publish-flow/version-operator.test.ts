import { expect, test } from 'vitest'
import { contentHash } from '../../engine/instance.js'
import {
  runVersionOperator,
  type Versioning,
  versionVariants,
} from '../../tools/harness/operators.js'
import { draftV1, draftV2, golden } from './scenario.js'

// Issue #37, STORIES.md Fuzzy paths: the Version operator publishes a new
// definition version between two steps of a golden path. A published version
// is immutable and carries a content hash, and an instance stays on the
// version that it started on (DF-2). The operator inserts a definition change
// and its publication at each step boundary; an instance that started on
// version 1 keeps its definitionVersion, the new version has a different hash,
// and the timeline records the change. The runner generates the variants from
// the golden path; no fuzzy test is written by hand.

/** The new definition version that the operator publishes between two steps (DF-2, DF-4). */
const versioning: Versioning = {
  actor: 'dana',
  slug: 'course-overload',
  definition: draftV2,
  started: draftV1,
}

test.fails('#37 the Version operator publishes a new version at each S01 step (S01)', async () => {
  // One variant per step boundary, in step order, so the generation is
  // deterministic (I6).
  const generated = versionVariants(golden, versioning)
  expect(generated).toHaveLength(golden.steps.length)
  expect(generated.map((variant) => variant.id)).toEqual([
    'version:after-step1',
    'version:after-step2',
    'version:after-step3',
  ])

  // Every variant inserts a definition change and its publication, and the new
  // version has a content hash other than the one the instance started on
  // (DF-2).
  for (const variant of generated) {
    expect(variant.scenario.steps).toHaveLength(golden.steps.length + 2)
    expect(variant.published.contentHash).not.toBe(contentHash(variant.started))
  }

  // The runner publishes at every boundary, and the oracles check each run: the
  // end state equals the variant's golden end state, the timeline is
  // consistent, and the in-progress instance keeps its definitionVersion
  // (DF-2).
  const variants = await runVersionOperator(golden, versioning)
  expect(variants).toHaveLength(golden.steps.length)
})
