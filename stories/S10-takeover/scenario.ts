import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TargetResolver } from '../../engine/routing.js'

// S10: take over from a peer on vacation (STORIES.md). The registrar task of
// the course-overload flow shows in the Available tab of Lee, Ana and Jordan.
// Lee claims it and goes on vacation. The step allows a takeover after four
// hours of idle time (AS-3); the engine takes that period as an argument. Ana
// takes the task from Lee, who has been idle for longer, and the engine refuses
// a takeover from the same view while Lee was active ten minutes ago, with the
// remaining time. The path is deterministic (I6): it reads no clock and no
// random source, and the directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06). */
export const STARTER = 'user:sam'

/** Lee and Ana, registrar staff, and Jordan, the registrar reviewer (STORIES.md, the cast). */
export const LEE = 'user:lee'
export const ANA = 'user:ana'
export const JORDAN = 'user:jordan'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The registrar task, the step that the story takes over (WF-1). */
export const REGISTRAR_STEP = 'registrar'

/** The resource of the registrar step (MVP.md 5.6). */
export const REGISTRAR_RESOURCE = `flow:${SLUG}/step:${REGISTRAR_STEP}`

/** The members of the registrar team when the request starts (AS-1, I13). */
export const REGISTRAR_MEMBERS: readonly string[] = [LEE, ANA, JORDAN]

/** The definition of version 1: a registrar step, then an archive step (WF-1). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
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

/** The data of Sam's request: the registrar step has no skip condition, so it is first (WF-1). */
export const data: ConditionData = {}

/** The directory of the story (AS-1, I13): a team resolves to its members, and a user to itself. */
export const resolve: TargetResolver = (target) => {
  if ('team' in target) return REGISTRAR_MEMBERS
  if ('user' in target) return [target.user]
  return []
}

/** The grants that apply to Sam: the All-Students group may start the flow (S02, ID-4, AC-1). */
export const starterGrants: readonly Grant[] = [
  { principal: 'group:All-Students', scopes: ['instance.start'], resource: `flow:${SLUG}` },
]
