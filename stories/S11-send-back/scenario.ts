import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TargetResolver } from '../../engine/routing.js'

// S11: send back for revision (STORIES.md). Sam's course-overload request is at
// the registrar step, held by Jordan, a registrar reviewer. Jordan holds only
// `step.outcome:send_back` on that step (AC-4), so he may send the request back
// to the starter's `request` step with a note and may not approve it. The send
// back needs a comment (WF-3), it moves the instance back to `request` as
// revision 2, and the note to Sam rides in the same commit (I2, SE-2). The path
// is deterministic (I6): it reads no clock and no random source, and the
// directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06). */
export const STARTER = 'user:sam'

/** Jordan, the registrar reviewer: he holds send back only, never approve (S02, AC-4). */
export const JORDAN = 'user:jordan'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The two steps: the starter's request, then the registrar task (WF-1). */
export const REQUEST_STEP = 'request'
export const REGISTRAR_STEP = 'registrar'

/** The resource of each step (MVP.md 5.6). */
export const REQUEST_RESOURCE = `flow:${SLUG}/step:${REQUEST_STEP}`
export const REGISTRAR_RESOURCE = `flow:${SLUG}/step:${REGISTRAR_STEP}`

/** The members of the registrar team when the request reaches it (AS-1, I13). */
export const REGISTRAR_MEMBERS: readonly string[] = [JORDAN]

/** The definition of version 1: a request step, then a registrar step (WF-1). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "outcomes": ["submit"]
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["approve", "reject", "send_back"]
    }
  ]
}
`)

/** The published version 1: a start needs a version with a content hash (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definition),
  definition,
}

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/** The data of Sam's request: no step has a skip condition, so the request step is first (WF-1). */
export const data: ConditionData = {}

/** The directory of the story (AS-1, I13): the starter and a team resolve, a user to itself. */
export const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [STARTER]
  if ('team' in target) return REGISTRAR_MEMBERS
  if ('user' in target) return [target.user]
  return []
}

/** The grants that apply to Sam: the All-Students group may start the flow (S02, ID-4, AC-1). */
export const starterGrants: readonly Grant[] = [
  { principal: STARTER, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The grants that apply to Sam on the request step: he submits his own request (S11, WF-1). */
export const samGrants: readonly Grant[] = [
  { principal: STARTER, scopes: ['step.outcome:submit'], resource: REQUEST_RESOURCE },
]

/**
 * The grants that apply to Jordan (S11, AC-4): he holds
 * `step.outcome:send_back` on the registrar step and no other scope, so he may
 * send the task back and may not approve it.
 */
export const jordanGrants: readonly Grant[] = [
  { principal: JORDAN, scopes: ['step.outcome:send_back'], resource: REGISTRAR_RESOURCE },
]
