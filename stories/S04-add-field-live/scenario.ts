import { parse } from '../../engine/definition.js'
import { contentHash } from '../../engine/instance.js'
import { scenario } from '../../tools/harness/scenario.js'

// S04: Dana adds a field while submissions are in progress (STORIES.md). A
// publication freezes the draft into an immutable version with a content hash
// (DF-2), so an instance that started on v1 stays on v1. A structural change
// creates v2 (DF-6), a draft that is not submitted rebinds to v2, and the
// difference from v1 to v2 names the change. This milestone's definition model
// has steps, targets, outcomes and skip conditions and no form fields yet, so a
// structural change (an added step) stands in for the new field; the field and
// its values arrive with FM-1 (issue #74). The path is deterministic (I6): it
// reads no clock and no random source.

/** The flow of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Version 1: the live definition, before Dana adds the field (DF-1). */
export const draftV1 = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] }
  ]
}
`)

/** Version 2: the structural change, its added step standing in for the field (DF-6). */
export const draftV2 = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] },
    { "key": "reason_category", "targets": [{ "starter": "starter" }] }
  ]
}
`)

/** The publication of version 1: the slug, the version, the hash and the frozen definition (DF-2). */
export const publishedV1 = {
  slug: SLUG,
  version: 1,
  contentHash: contentHash(draftV1),
  definition: draftV1,
}

/** The publication of version 2, after the structural change (DF-2, DF-6). */
export const publishedV2 = {
  slug: SLUG,
  version: 2,
  contentHash: contentHash(draftV2),
  definition: draftV2,
}

/** The golden path: push and publish v1, then add the field and publish v2 (S04). */
export const golden = scenario({
  slug: 'add-field-live',
  steps: [
    { actor: 'dana', type: 'config.definition.changed@1', payload: draftV1 },
    { actor: 'dana', type: 'config.definition.published@1', payload: publishedV1 },
    { actor: 'dana', type: 'config.definition.changed@1', payload: draftV2 },
    { actor: 'dana', type: 'config.definition.published@1', payload: publishedV2 },
  ],
})
