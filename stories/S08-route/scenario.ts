import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import { contentHash } from '../../engine/instance.js'
import type { Membership, TargetContext } from '../../engine/resolve.js'

// S08: route each task to real, current people (STORIES.md). Dana starts the
// course-overload flow, and the advisor step names its recipient through the
// form field `advisor` (AS-1). When that field names a deprovisioned user the
// task has no recipient, so it goes to the Unroutable queue and Priya, the flow
// owner, gets an alert (I10, AS-5). The registrar step names the
// registrar-office team, which resolves live (AS-4): when Ana joins the team
// while the task is open, a re-resolution shows the task to her with no new
// publication. The path is deterministic (I6): it reads no clock and no random
// source, and the directory is injected.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Priya, the flow owner: she has task.reassign on the flow and gets the I10 alert. */
export const OWNER = 'user:priya'

/** Dana, the principal who starts the flow: the `starter` dynamic target names her. */
export const STARTER = 'user:dana'

/** Ana, who joins the registrar-office team while a registrar task is open (AS-4). */
export const ANA = 'user:ana'

/** The two recipients of the advisor step (S08): the field, and the team. */
export const ADVISOR_FIELD = 'advisor'
export const REGISTRAR_TEAM = 'registrar-office'

/** The definition of the story: an advisor step with a field target and a registrar step with a team target (AS-1). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "advisor",
      "targets": [{ "field": "${ADVISOR_FIELD}" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "registrar",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["record"]
    }
  ]
}
`)

/** The content hash that an instance records as its version (DF-2, I13). */
export const versionHash = contentHash(definition)

/** Lee and Jordan, the members that registrar-office holds when Dana starts (AS-4, ID-4). */
export const REGISTRAR_MEMBERS: readonly string[] = ['user:lee', 'user:jordan']

/**
 * The initial directory of the story (ID-4, AS-4). A provisioned user maps to
 * itself, a group and a team map to their current members, and the advisor that
 * the field names, user:okafor, is absent: the account was deprovisioned.
 */
export const INITIAL_DIRECTORY: Readonly<Record<string, readonly string[]>> = {
  [STARTER]: [STARTER],
  [OWNER]: [OWNER],
  'user:lin': ['user:lin'],
  'user:lee': ['user:lee'],
  'user:jordan': ['user:jordan'],
  'CS-Chairs': ['user:lin'],
  [REGISTRAR_TEAM]: REGISTRAR_MEMBERS,
}

/** The advisor that the field names before the account is deprovisioned. */
export const DEPROVISIONED_ADVISOR = 'user:okafor'

/** The advisor that the field names while the account is provisioned. */
export const PROVISIONED_ADVISOR = 'user:lin'

/** The context of a run whose advisor field names a deprovisioned user (AS-1, I10). */
export const deprovisioned: TargetContext = {
  data: { [ADVISOR_FIELD]: DEPROVISIONED_ADVISOR },
  starter: STARTER,
  managerOf: OWNER,
}

/** The context of a run whose advisor field names a provisioned user (AS-1). */
export const provisioned: TargetContext = {
  data: { [ADVISOR_FIELD]: PROVISIONED_ADVISOR },
  starter: STARTER,
  managerOf: OWNER,
}

/** The data of Dana's request (AS-1). */
export const data: ConditionData = { [ADVISOR_FIELD]: DEPROVISIONED_ADVISOR }

/** One injected directory: a membership that reads current members, and a join for the story (ID-4, AS-4). */
export type Directory = {
  /** The membership that a target resolves against. It reads the current members each call (AS-4). */
  readonly membership: Membership
  /** Add one member to a principal, as ID-5 synchronization would after a join (AS-4). */
  join(principal: string, member: string): void
}

/**
 * A mutable injected directory for the story (ID-4, AS-4). A group or a team
 * re-reads its members on every call, so the story can show a live target;
 * `join` adds a member between resolutions.
 */
export function directory(initial: Readonly<Record<string, readonly string[]>>): Directory {
  const members = new Map(Object.entries(initial).map(([key, value]) => [key, [...value]]))
  return {
    membership: (principal) => members.get(principal) ?? [],
    join: (principal, member) => {
      members.set(principal, [...(members.get(principal) ?? []), member])
    },
  }
}
