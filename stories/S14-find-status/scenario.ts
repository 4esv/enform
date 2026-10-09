import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, type JsonValue, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TargetResolver } from '../../engine/routing.js'

// S14: find the status of a submission (STORIES.md). Sam's course-overload
// request is at the registrar step. He reads the status of his own instance:
// the step line, the holder and the wait state, and the chair step that a
// condition skipped at routing (S05). Sam reads the status but not the notes
// of the people who act on the advisor step, and not the values that a scope
// guards (VT-3, VT-4, I8). The path is deterministic (I6): it reads no clock
// and no random source, and the directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06, AC-5). */
export const STARTER = 'user:sam'

/** Dr. Okafor, the advisor of Sam: he acts on the advisor step (S11). */
export const OKAFOR = 'user:okafor'

/** Lee and Ana, registrar staff, peers in the registrar team (S10). */
export const LEE = 'user:lee'
export const ANA = 'user:ana'

/** Dr. Lin, the chair: a member of CS-Chairs, the group of the chair step (S05). */
export const LIN = 'user:lin'

/** Priya, the department coordinator: she reads every instance and timeline (S02). */
export const PRIYA = 'user:priya'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The four steps of the story: the conditional chair, then request, advisor, registrar (WF-1). */
export const CHAIR_STEP = 'chair'
export const REQUEST_STEP = 'request'
export const ADVISOR_STEP = 'advisor'
export const REGISTRAR_STEP = 'registrar'

/** The resource of the registrar step (MVP.md 5.6): a step-scoped restricted value reads it. */
export const REGISTRAR_RESOURCE = `flow:${SLUG}/step:${REGISTRAR_STEP}`

/** The members of the registrar team when the request reaches it (AS-1, I13). */
export const REGISTRAR_MEMBERS: readonly string[] = [LEE, ANA]

/** The skip condition of the chair step (S05, FM-5): a small overload skips the chair. */
export const chairSkipWhen: JsonValue = { '<=': [{ var: 'overload_credits' }, 2] }

/**
 * The definition of version 1 (WF-1). The chair step is conditional, so a
 * small overload skips it at routing (S05, WF-1); the request, the advisor and
 * the registrar follow.
 */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "${CHAIR_STEP}",
      "targets": [{ "group": "CS-Chairs" }],
      "outcomes": ["approve", "send_back"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    },
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "outcomes": ["submit"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back"]
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

/** The data of the story: two overload credits, so the chair step is skipped (S05). */
export const data: ConditionData = { overload_credits: 2 }

/** The directory of the story (AS-1, I13): a group, a field, a team and the starter resolve. */
export const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [STARTER]
  if ('field' in target) return [OKAFOR]
  if ('group' in target) return [LIN]
  if ('team' in target) return REGISTRAR_MEMBERS
  return []
}

/** The grants that apply to Sam: the All-Students group may start the flow (S02, ID-4, AC-1). */
export const starterGrants: readonly Grant[] = [
  { principal: 'group:All-Students', scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The grants that apply to Sam on the request step: he submits his own request (S14, WF-1). */
export const samGrants: readonly Grant[] = [
  {
    principal: STARTER,
    scopes: ['step.outcome:submit'],
    resource: `flow:${SLUG}/step:${REQUEST_STEP}`,
  },
]

/** The grants that apply to Dr. Okafor on the advisor step (S11, AC-4). */
export const okaforGrants: readonly Grant[] = [
  {
    principal: OKAFOR,
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: `flow:${SLUG}/step:${ADVISOR_STEP}`,
  },
]

/** The grants that apply to Ana on the registrar step: she approves, rejects or sends back (S09). */
export const anaGrants: readonly Grant[] = [
  {
    principal: ANA,
    scopes: ['step.outcome:approve', 'step.outcome:reject', 'step.outcome:send_back'],
    resource: REGISTRAR_RESOURCE,
  },
]

/** The grants that apply to Lee on the registrar step: he approves or rejects (S09). */
export const leeGrants: readonly Grant[] = [
  {
    principal: LEE,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: REGISTRAR_RESOURCE,
  },
]

/** The grants that apply to Priya: she reads every instance and every timeline (S02, AC-1). */
export const priyaGrants: readonly Grant[] = [
  { principal: PRIYA, scopes: ['instance.read', 'instance.timeline'], resource: `flow:${SLUG}` },
]

/**
 * One restricted value on the registrar step (VT-4, FM-3, I8): the registrar
 * note that a scope guards. Only a principal that holds `instance.timeline`
 * reads it, so the starter does not. Form fields arrive with FM-1.
 */
export const registrarNote: {
  readonly key: string
  readonly value: JsonValue
  readonly scope: string
  readonly resource: string
} = {
  key: 'registrar_note',
  value: 'Duplicate of request #4411',
  scope: 'instance.timeline',
  resource: REGISTRAR_RESOURCE,
}
