import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import type { Flow, FlowVersion } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { TimerSettings } from '../../engine/reminders.js'
import type { TargetResolver } from '../../engine/routing.js'

// S12: reminders and escalation (STORIES.md). Sam starts a course-overload
// request whose advisor step lands on Dr. Okafor. Okafor claims it and then
// waits. Priya wants no task to wait in silence: with a reminder interval of
// one day the engine captures one reminder per day, and at the deadline of
// three days it escalates to the CS-Chairs group without removing Okafor
// (SE-3, SE-4). The reminder interval and the deadline are flow settings (a
// later schema change), so the story injects them, and the time the task
// started comes from the injected clock (I6). The path is deterministic.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** Sam, the student who starts the request (S06). */
export const STARTER = 'user:sam'

/** Dr. Okafor, the advisor of Sam: he acts on the advisor step (S08, AS-1). */
export const OKAFOR = 'user:okafor'

/** The instance that the story runs (I3); the instance record carries no id yet. */
export const INSTANCE = 'instance-1'

/** The advisor step, the one task that the story reminds and escalates (WF-1). */
export const ADVISOR_STEP = 'advisor'

/** The resource of the advisor step (MVP.md 5.6). */
export const ADVISOR_RESOURCE = `flow:${SLUG}/step:${ADVISOR_STEP}`

/** The outcome that completes the advisor task (WF-2). */
export const APPROVE = 'approve'

/** The members of the advisor target when the request starts (AS-1, I13). */
export const ADVISOR_MEMBERS: readonly string[] = [OKAFOR]

/** The targets that the escalation adds at the deadline (SE-4): the chairs of CS. */
export const ESCALATION_TARGETS: readonly string[] = ['group:CS-Chairs']

/** The definition of version 1: the advisor step (WF-1). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["${APPROVE}"]
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

/** The data of Sam's request: the advisor step has no skip condition, so it is first (WF-1). */
export const data: ConditionData = {}

/** The directory of the story (AS-1, I13): the starter and the advisor field resolve. */
export const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [STARTER]
  if ('field' in target) return ADVISOR_MEMBERS
  return []
}

/** The grants that apply to Sam: the All-Students group may start the flow (S02, AC-1). */
export const starterGrants: readonly Grant[] = [
  { principal: STARTER, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The grants that apply to Dr. Okafor: he approves on the advisor step (S08, AC-4). */
export const okaforGrants: readonly Grant[] = [
  { principal: OKAFOR, scopes: [`step.outcome:${APPROVE}`], resource: ADVISOR_RESOURCE },
]

/** One day in milliseconds (SE-3): the reminder interval of the story. */
export const DAY = 24 * 60 * 60 * 1000

/** The time that the task starts, from the injected clock (I6). */
export const NOW = 1_700_000_000_000

/**
 * The timers of the story (SE-3, SE-4): the instance, the task start, a one-day
 * reminder interval and a three-day deadline, and the CS-Chairs group that the
 * escalation adds. The flow states these settings (a later schema change), so
 * the story injects them, as S10 injects the idle period.
 */
export const timers: TimerSettings = {
  instance: INSTANCE,
  since: NOW,
  reminderInterval: DAY,
  deadline: NOW + 3 * DAY,
  escalationTargets: ESCALATION_TARGETS,
}
