import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TargetResolver } from '../../engine/routing.js'

// S13: withdraw or cancel a submission (STORIES.md). Sam's course-overload
// request reaches the registrar step, held by Ana. Sam withdraws his own
// instance (WF-4, AC-5); Priya, a coordinator, cancels an invalid one, and she
// holds `instance.cancel` (AC-5, AC-1). Both close the open task and notify
// Ana, the holder, in the same commit (SE-5, I2). A person undoes a withdrawal
// or a cancellation within the flow's undo period, which restores the previous
// step and holder as a compensating event (WF-5, I4). The path is
// deterministic (I6): it reads no clock and no random source, and the
// directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06). */
export const STARTER = 'user:sam'

/** Ana, a registrar staff member: she holds the registrar task (S13, AS-2). */
export const ANA = 'user:ana'

/** Priya, the department coordinator: she holds `instance.cancel` (S13, AC-5). */
export const PRIYA = 'user:priya'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The two steps: the starter's request, then the registrar task (WF-1). */
export const REQUEST_STEP = 'request'
export const REGISTRAR_STEP = 'registrar'

/** The resource of each step (MVP.md 5.6). */
export const REQUEST_RESOURCE = `flow:${SLUG}/step:${REQUEST_STEP}`
export const REGISTRAR_RESOURCE = `flow:${SLUG}/step:${REGISTRAR_STEP}`

/** The members of the registrar team when the request reaches it (AS-1, I13). */
export const REGISTRAR_MEMBERS: readonly string[] = [ANA]

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
      "outcomes": ["approve", "reject"]
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

/** The grants that apply to Sam on the request step: he submits his own request (S13, WF-1). */
export const samGrants: readonly Grant[] = [
  { principal: STARTER, scopes: ['step.outcome:submit'], resource: REQUEST_RESOURCE },
]

/** The grants that apply to Priya: she holds `instance.cancel` on the flow (S13, AC-5). */
export const priyaGrants: readonly Grant[] = [
  { principal: PRIYA, scopes: ['instance.cancel'], resource: `flow:${SLUG}` },
]
