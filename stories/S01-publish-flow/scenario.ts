import { parse } from '../../engine/definition.js'
import { contentHash } from '../../engine/instance.js'
import { scenario } from '../../tools/harness/scenario.js'

// S01: Dana creates and publishes a flow (STORIES.md). The flow is a
// definition (DF-1). Dana pushes the first draft (DF-4), publishes it as
// version 1 with a content hash (DF-2, VT-6), then pushes a change that opens
// a new draft while version 1 stays as it was; an instance created from
// version 1 stays on it (I13). Validation reads a file and changes nothing
// (DF-1), so it is not a step; the scenario test calls `validate` directly. The
// path is deterministic (I6): it reads no clock and no random source.

/** The first draft of the pilot flow, from its file (DF-1). */
export const draftV1 = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] }
  ]
}
`)

/** The next draft: it adds the chair step, and leaves version 1 unchanged (DF-2). */
export const draftV2 = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] },
    { "key": "chair", "targets": [{ "group": "CS-Chairs" }], "outcomes": ["approve", "send_back"] }
  ]
}
`)

/** The publication of version 1: the slug, the version, the hash and the frozen definition. */
export const publishedV1 = {
  slug: 'course-overload',
  version: 1,
  contentHash: contentHash(draftV1),
  definition: draftV1,
}

export const golden = scenario({
  slug: 'publish-flow',
  steps: [
    { actor: 'dana', type: 'config.definition.changed@1', payload: draftV1 },
    { actor: 'dana', type: 'config.definition.published@1', payload: publishedV1 },
    { actor: 'dana', type: 'config.definition.changed@1', payload: draftV2 },
  ],
})
