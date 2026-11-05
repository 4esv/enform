import type { Grant } from '../../engine/authorize.js'
import { DEFINITION_CHANGED, parse } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { scenario } from '../../tools/harness/scenario.js'
import { DANA, FLOW, membership } from '../example-flow.js'

// S01: Dana creates and publishes a flow (STORIES.md). The flow is a
// definition (DF-1). Dana pushes the first draft (DF-4), publishes it as
// version 1 with a content hash (DF-2, VT-6), then pushes a change that opens
// a new draft while version 1 stays as it was; an instance created from
// version 1 stays on it (I13). Validation reads a file and changes nothing
// (DF-1), so it is not a step; the scenario test calls `validate` directly. The
// path is deterministic (I6): it reads no clock and no random source.

/** The flow slug of the pilot flow (ID-1). */
const SLUG = 'course-overload'

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
  slug: SLUG,
  version: 1,
  contentHash: contentHash(draftV1),
  definition: draftV1,
}

/** The installation before the story: Dana, the first administrator, builds every flow (STORIES.md, Cast). */
export const bootstrap: readonly Grant[] = [
  { principal: DANA, scopes: ['org.grants', 'org.teams', 'org.impersonate'], resource: 'org' },
  { principal: DANA, scopes: ['flow.build'], resource: '*' },
]

export const golden = scenario({
  slug: 'publish-flow',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: [
    {
      actor: DANA,
      type: 'config.definition.changed@1',
      payload: { flow: SLUG, definition: draftV1 },
    },
    { actor: DANA, type: 'config.definition.published@1', payload: publishedV1 },
    {
      actor: DANA,
      type: 'config.definition.changed@1',
      payload: { flow: SLUG, definition: draftV2 },
    },
  ],
})

/** The indexes of the story's steps. */
export const STEP = { push: 0, publish: 1, change: 2 } as const

/**
 * What each step requires of its actor (I8), for the Actor operator: a push
 * and a publication need `flow.build` on the flow (DF-5, D2).
 */
export const requires: Requirements = (step, index) => {
  switch (step.type) {
    case DEFINITION_CHANGED:
    case DEFINITION_PUBLISHED:
      return { scope: 'flow.build', resource: FLOW }
    default:
      throw new Error(`S01: step ${index + 1} has no requirement (${step.type})`)
  }
}
