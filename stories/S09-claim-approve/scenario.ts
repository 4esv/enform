import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TargetResolver } from '../../engine/routing.js'

// S09: claim and approve (STORIES.md). The registrar task of the
// course-overload flow shows in the Available tab of Lee, Ana and Jordan. The
// first to claim it owns it (AS-2). Lee claims it and completes it with
// approve, which his `step.outcome:approve` grant authorizes and no other
// outcome does (AC-4). The path is deterministic (I6): it reads no clock and
// no random source, and the directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06). */
export const STARTER = 'user:sam'

/** Lee and Ana, registrar staff, and Jordan, the registrar reviewer (STORIES.md, the cast). */
export const LEE = 'user:lee'
export const ANA = 'user:ana'
export const JORDAN = 'user:jordan'

/** Priya, the department coordinator, holds the archive step (STORIES.md, the cast). */
export const PRIYA = 'user:priya'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The two steps of the story: the registrar task, then the archive task (WF-1). */
export const REGISTRAR_STEP = 'registrar'
export const ARCHIVE_STEP = 'archive'

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
    },
    {
      "key": "${ARCHIVE_STEP}",
      "targets": [{ "user": "${PRIYA}" }],
      "outcomes": ["record"]
    }
  ]
}
`)

/** The registrar step alone: the last step, so a completion marks the instance done (S09). */
export const terminalDefinition: FlowDefinition = { ...definition, steps: [definition.steps[0]] }

/** The published version 1: a start needs a version with a content hash (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definition),
  definition,
}

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/** The data of Sam's request: no step has a skip condition, so the registrar task is first (WF-1). */
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

/**
 * The grants that apply to Lee (S09, AC-4): he holds `step.outcome:approve`
 * on the registrar step and no other scope, so he may approve the task and may
 * not choose another outcome.
 */
export const leeGrants: readonly Grant[] = [
  { principal: LEE, scopes: ['step.outcome:approve'], resource: REGISTRAR_RESOURCE },
]
