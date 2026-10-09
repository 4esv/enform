import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TargetResolver } from '../../engine/routing.js'

// S06: Sam starts and submits a submission (STORIES.md). He opens the form
// link, fills it in and submits it. The engine never creates an anonymous
// draft (ID-2): the start needs a signed-in principal, here Sam, and the scope
// instance.start on the flow (AC-1). The start routes the draft to the first
// step whose skip condition is false (WF-1, I10): the fixture data is not
// urgent, so the triage step is skipped and the draft routes to the advisor
// step, whose user target resolves to Dr. Okafor. The submit records the
// assignment email that he receives (I2, SE-1). The path is deterministic
// (I6): it reads no clock and no random source.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** The definition of version 1, the version that a start pins the instance to (DF-1, DF-2). */
export const definitionV1: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "triage",
      "targets": [{ "group": "CS-Chairs" }],
      "skipWhen": { "==": [{ "var": "urgent" }, false] }
    },
    {
      "key": "advisor",
      "targets": [{ "user": "user:okafor" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "registrar",
      "targets": [{ "user": "user:lee" }],
      "outcomes": ["record"]
    }
  ]
}
`)

/** The published version 1: the start needs a version with a content hash (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definitionV1),
  definition: definitionV1,
}

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/** The data of Sam's request: it is not urgent, so the triage step is skipped (WF-1). */
export const samData: ConditionData = { urgent: false }

/** The grants that apply to Sam: the All-Students group may start the flow (S02, ID-4, AC-1). */
export const samGrants: readonly Grant[] = [
  { principal: 'group:All-Students', scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The directory of the story (ID-4, AS-4): a user target names its principal, and a group or team resolves to nobody. */
export const resolve: TargetResolver = (target) => ('user' in target ? [target.user] : [])
