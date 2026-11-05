import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { DEFINITION_CHANGED, type FlowDefinition, parse } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED, type Flow } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import { instanceOf, type ProjectedInstance } from '../../engine/instances.js'
import type { OperationDeps } from '../../engine/operation.js'
import {
  assigneesAddedBy,
  MINUTE_MS,
  type ScheduledTimer,
  TIMER_FIRED,
  type TimerSettings,
  timersOfStep,
} from '../../engine/reminders.js'
import type { Membership } from '../../engine/resolve.js'
import { sideEffectKey } from '../../engine/sideEffects.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import type { Requirements, Versioning } from '../../tools/harness/operators.js'
import { type Step, type StepClock, scenario, stepOperation } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  bootstrap,
  CHAIR_STEP,
  CHAIRS_GROUP,
  DANA,
  declared,
  definitionV2,
  directory,
  FLOW,
  grantsOfPerson,
  INSTANCE_ID,
  LIN,
  membership,
  OKAFOR,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  SAM,
  SLUG,
  samValues,
  setupSteps,
  stepResource,
} from '../example-flow.js'

// S12: reminders and escalation (STORIES.md). Sam's request lands on Dr.
// Okafor, who claims it and then waits. Priya wants no task to wait in
// silence: the advisor step reminds every day and escalates at the deadline
// of three days to the CS-Chairs group, without removing Okafor (SE-3,
// SE-4). The worker fires each timer as one `timer.fired@1` event that
// carries the one side effect of the timer, whose I3 identity is the
// instance, the step, the rule and the occurrence, so a timer fires a maximum
// of one time (I2, I3). A timer firing is the worker's, not a client's, so
// the story declares it as the event the worker appends (server/db.ts,
// fireDueTimers), built through the engine's timers. The timers read elapsed
// time, so the story declares the clock that places its steps (I6).

/** Sam's request: a two-credit overload, so the chair step is skipped (S05). */
export const values = samValues(2)

/** One day in milliseconds (SE-3): the reminder interval of the story. */
export const DAY = 24 * 60 * MINUTE_MS

/** The reminder interval and the deadline of the advisor step, in minutes (SE-3, SE-4). */
export const REMINDER_MINUTES = 24 * 60
export const DEADLINE_MINUTES = 3 * 24 * 60

/** The targets that the escalation adds at the deadline (SE-4): the chairs of CS. */
export const ESCALATION_TARGETS: readonly string[] = [`group:${CHAIRS_GROUP}`]

/**
 * The example flow with the timers of the story on the advisor step (SE-3,
 * SE-4): a one-day reminder interval, a three-day deadline, and the CS-Chairs
 * group as the escalation target.
 */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number", "required": true },
        { "key": "advisor", "control": "user", "required": true }
      ],
      "editable": ["summary", "overload_credits", "advisor"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back"],
      "reminderMinutes": ${REMINDER_MINUTES},
      "deadlineMinutes": ${DEADLINE_MINUTES},
      "escalationTargets": [{ "group": "${CHAIRS_GROUP}" }]
    },
    {
      "key": "${CHAIR_STEP}",
      "targets": [{ "group": "${CHAIRS_GROUP}" }],
      "outcomes": ["approve", "send_back"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["approve", "reject"],
      "takeover": "after-idle",
      "idleMinutes": 240
    }
  ]
}
`)

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

/** How the Version operator publishes version 2 between two steps: the fixture's v2, from this story's v1. */
export const versioning: Versioning = {
  actor: DANA,
  slug: SLUG,
  definition: definitionV2,
  started: definition,
}

/** The advisor step of the story, the one task that reminds and escalates (WF-1). */
export const advisorStep = definition.steps[1]

/** The time of the first step (I6): every other step is placed from it. */
export const T0 = 1_700_000_000_000

/** The indexes of the story's steps after the setup. */
export const STEP = {
  start: 6,
  submit: 7,
  claim: 8,
  reminder1: 9,
  reminder2: 10,
  reminder3: 11,
  escalation: 12,
  approve: 13,
} as const

/** The time the advisor task started: the submit routed the request to it (SE-3, I6). */
export const SINCE = T0 + STEP.submit * MINUTE_MS

/**
 * The clock of the story (I6): the setup, the request and the claim run one
 * minute apart; a reminder fires at each elapsed day; the escalation fires at
 * the three-day deadline; and Dr. Okafor approves an hour after it.
 */
export const clock: StepClock = (index) => {
  if (index <= STEP.claim) return T0 + index * MINUTE_MS
  if (index <= STEP.reminder3) return SINCE + (index - STEP.claim) * DAY
  if (index === STEP.escalation) return SINCE + 3 * DAY
  return SINCE + 3 * DAY + 60 * MINUTE_MS
}

/** The timer settings of the story for the engine's due checks (SE-3, SE-4). */
export const timers: TimerSettings = {
  instance: INSTANCE_ID,
  since: SINCE,
  reminderInterval: DAY,
  deadline: SINCE + 3 * DAY,
  escalationTargets: ESCALATION_TARGETS,
}

/** The directory the escalation resolves its group through at the firing (SE-4, AS-4): Dr. Lin chairs CS. */
export const groupMembership: Membership = (principal) => (principal === CHAIRS_GROUP ? [LIN] : [])

/**
 * The timers the advisor step schedules when the submit enters it (SE-3,
 * SE-4): three reminders, one per elapsed day up to the deadline, then the
 * escalation at the deadline, exactly as the server schedules them.
 */
export const scheduled: readonly ScheduledTimer[] = timersOfStep(advisorStep, {
  instance: INSTANCE_ID,
  since: SINCE,
  to: OKAFOR,
})

/** The injected sources of step `index` (I6): the story clock and the `op-N` id. */
function depsAt(index: number): OperationDeps {
  return { clock: () => clock(index), ids: () => `op-${index + 1}` }
}

/** The state after the steps, replayed under the story clock (I6). */
export function stateAt(steps: readonly Step[]): State {
  let state = emptyState
  steps.forEach((step, index) => {
    state = apply(stepOperation(step, index, clock), state)
  })
  return state
}

/** The instance as the log projects it after the steps, under the story clock (I4). */
export function instanceAt(steps: readonly Step[]): ProjectedInstance {
  const instance = instanceOf(stateAt(steps).log, INSTANCE_ID)
  if (instance === undefined) throw new Error(`the steps hold no instance ${INSTANCE_ID}`)
  return instance
}

/** The worker, the actor of a timer firing: the timeline attributes every event (I14). */
export const WORKER = 'system'

/**
 * The event the worker appends when one timer fires (SE-3, SE-4, I2, I3): the
 * timer id, its instance, step and kind, the time it was due, the one side
 * effect it carries, and, for an escalation, the assignees it adds, resolved
 * at the firing (AS-4, I13), exactly as `fireDueTimers` records them.
 */
function firing(timer: ScheduledTimer): Step {
  const added =
    timer.kind === 'escalation'
      ? assigneesAddedBy(ADVISOR_STEP, ESCALATION_TARGETS, groupMembership)
      : []
  return {
    actor: WORKER,
    type: TIMER_FIRED,
    payload: {
      timerId: sideEffectKey(timer.entry),
      instanceId: INSTANCE_ID,
      step: ADVISOR_STEP,
      kind: timer.kind,
      fireAt: timer.fireAt,
      ...(added.length === 0 ? {} : { assignees: added }),
    },
    outbox: [timer.entry],
  }
}

/** The golden path: the setup, the request, the claim, three reminders, the escalation, and the approval. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps(definition)]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Sam starts and submits; the submit routes to Dr. Okafor and the advisor
  // task's timers count from it (ADR 0014, SE-3).
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsAt(STEP.start), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAt(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: sam, owner: SAM },
    depsAt(STEP.submit)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dr. Okafor claims the task and then waits (S09).
  const claimed = claim(instanceAt(steps), OKAFOR, 1, depsAt(STEP.claim))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  steps.push(declared(claimed.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))

  // The worker fires one reminder per elapsed day, then the escalation at
  // the deadline, which adds the CS-Chairs group without removing Okafor
  // (SE-3, SE-4, I3).
  for (const timer of scheduled) steps.push(firing(timer))

  // Dr. Okafor approves after the deadline: the chair step is skipped, so the
  // request routes to the registrar team (WF-1, AS-4).
  const approved = complete(
    instanceAt(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    depsAt(STEP.approve)
  )
  if (approved.operation === undefined) throw new Error(approved.reason)
  steps.push(
    declared(approved.operation, {
      instanceId: INSTANCE_ID,
      version: 2,
      outcome: 'approve',
      values: {},
    })
  )
  return steps
}

export const golden = scenario({
  slug: 'reminders-escalation',
  flowSlug: SLUG,
  bootstrap,
  membership,
  clock,
  steps: goldenSteps(),
})

/**
 * What each step requires of its actor (I8): the starter for the submit, the
 * advisor for the claim and the approval, and the worker for a timer firing,
 * which no person of the cast is.
 */
export const requires: Requirements = (step, index) => {
  switch (step.type) {
    case DEFINITION_CHANGED:
    case DEFINITION_PUBLISHED:
      return { scope: 'flow.build', resource: FLOW }
    case TEAM_CHANGE_TYPE:
      return { scope: 'org.teams', resource: 'org' }
    case INSTANCE_STARTED:
      return { scope: 'instance.start', resource: FLOW }
    case INSTANCE_SUBMITTED:
      return { actors: [SAM] }
    case STEP_CLAIMED:
      return { actors: [OKAFOR] }
    case TIMER_FIRED:
      return { actors: [WORKER] }
    case STEP_COMPLETED:
      return {
        scope: 'step.outcome:approve',
        resource: stepResource(ADVISOR_STEP),
        actors: [OKAFOR],
      }
    default:
      throw new Error(`S12: step ${index + 1} has no requirement (${step.type})`)
  }
}

/**
 * The server state the interface path starts from (#269, S12): the three
 * reminders and the escalation fired. The seed's operation ids are prefixed,
 * so the browser's `op-1` is a new operation and not a retry of the seed's
 * first one (I1).
 */
export function guiSeed(): State {
  const state = stateAt(golden.steps.slice(0, STEP.approve))
  const log = state.log.map((event) => ({ ...event, operationId: `seed-${event.operationId}` }))
  return { applied: new Set(log.map((event) => event.operationId)), log }
}

/**
 * The interface path of S12 (STORIES.md): in live, the step tracker shows
 * the due date, the reminders the worker sent and the escalation (VT-2, SE-3,
 * SE-4); then Dr. Okafor approves. The seed holds the fired timers; the gui
 * run posts only the approval, which the api run posts the same way.
 */
function guiSteps(seed: State): readonly Step[] {
  const resolve = directory(values)
  const instance = instanceOf(seed.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('S12 gui: no instance')
  const approved = complete(
    instance,
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    // The gui scenario's first step: its id and time are the browser's (I6).
    { clock: () => clock(STEP.approve), ids: () => 'op-1' }
  )
  if (approved.operation === undefined) throw new Error(approved.reason)
  return [
    declared(approved.operation, {
      instanceId: INSTANCE_ID,
      version: 2,
      outcome: 'approve',
      values: {},
    }),
  ]
}

export const guiGolden = scenario({
  slug: 'reminders-escalation',
  flowSlug: SLUG,
  bootstrap,
  membership,
  clock: (index) => clock(STEP.approve + index),
  steps: guiSteps(guiSeed()),
  gui: [
    {
      // Dr. Okafor reads his task: due at the deadline, three reminders sent
      // and the escalation fired, as the worker recorded them (VT-2).
      instance: INSTANCE_ID,
      actor: OKAFOR,
      steps: 0,
      actions: [
        { expectSelector: '[data-tracker-step="advisor"][data-tracker-state="opened"]' },
        { expectSelector: '[data-tracker-step="advisor"] [data-tracker-due]' },
        { expectSelector: '[data-tracker-step="advisor"] [data-tracker-reminder]' },
        { expectSelector: '[data-tracker-step="advisor"] [data-tracker-escalated]' },
      ],
    },
    {
      instance: INSTANCE_ID,
      actions: [
        { click: '[data-outcome="approve"]' },
        // The notification names the outcome; Dr. Okafor's read of the instance
        // ends with the step, so the page says so beside it (A4).
        { expectSelector: '[data-toast]' },
      ],
    },
  ],
})
