import type { Grant } from '../../engine/authorize.js'
import { parse } from '../../engine/definition.js'
import { scenario } from '../../tools/harness/scenario.js'

// S03: Priya edits the text of a form (STORIES.md). A definition change is
// edit-class or structural, and the class picks the scope (DF-5, D2): an
// edit-class change needs `flow.edit`, a structural change needs `flow.build`.
// This milestone's definition model has steps, targets, outcomes and skip
// conditions, and no form fields or labels yet, so the golden path edits an
// option (edit-class) and the test checks a step change (structural) against
// the guard. The literal label and field cases arrive with FM-1 (issue #74).
// The path is deterministic (I6): it reads no clock and no random source.

/** The flow of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** The resource of the flow (MVP.md 5.6): a grant on it covers all of its steps. */
export const FLOW = `flow:${SLUG}`

/** The base draft, before Priya edits it (DF-1). */
export const draft = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] }
  ]
}
`)

/** Priya's edit-class change: the advisor gains the dropdown option "escalate" (S03, DF-5). */
export const edited = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back", "escalate"] }
  ]
}
`)

/** Priya's structural change: it adds the chair step, which the guard rejects (S03, DF-5). */
export const withStep = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] },
    { "key": "chair", "targets": [{ "group": "CS-Chairs" }], "outcomes": ["approve", "send_back"] }
  ]
}
`)

/** Dana's grant: she may change all parts of the flow (MVP.md 5.6, `flow.build`). */
export const danaGrant: Grant = { principal: 'dana', scopes: ['flow.build'], resource: FLOW }

/** Priya's grant: she may edit an option or a label, and no more (S03, `flow.edit`). */
export const priyaGrant: Grant = { principal: 'user:priya', scopes: ['flow.edit'], resource: FLOW }

/** The golden path: Dana pushes the first draft, then Priya pushes her edit (S03). */
export const golden = scenario({
  slug: 'edit-text',
  steps: [
    { actor: 'dana', type: 'config.definition.changed@1', payload: draft },
    { actor: 'user:priya', type: 'config.definition.changed@1', payload: edited },
  ],
})
