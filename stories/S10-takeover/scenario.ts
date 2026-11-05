import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { instanceOf, type ProjectedInstance } from '../../engine/instances.js'
import type { OperationDeps } from '../../engine/operation.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { STEP_TAKEN_OVER, takeover } from '../../engine/takeover.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { EVENT_UNDONE, undoAction } from '../../engine/undo.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, type StepClock, scenario, stepOperation } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  declared,
  definitionV1,
  directory,
  exampleTeamState,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  JORDAN,
  LEE,
  membership,
  OKAFOR,
  REGISTRAR_STEP,
  SAM,
  SLUG,
  samValues,
  seedApproved,
  seedClaimed,
  seedSubmitted,
  setupSteps,
  stepResource,
} from '../example-flow.js'

// S10: take over from a peer on vacation (STORIES.md). Sam's request reaches
// the registrar step, whose team target resolves to Lee, Ana and Jordan
// (AS-4). Lee claims it and goes on vacation. The step allows a takeover after
// four hours of idle time (AS-3, the fixture's `idleMinutes`). Two days later
// Ana takes the task from Lee with a reason: the engine records who took it,
// from whom, when and why, and notifies Lee in the same commit (WF-5, I14,
// I2). Lee, the previous holder, may undo the takeover (WF-5, A2), and a flow
// owner with `task.reassign` may too. Every step after the setup is a client
// intent that the server resolves (ADR 0010). The idle time is elapsed time,
// so the story declares the clock that places its steps (I6): the golden
// step clock counts milliseconds, which never reaches four hours.

/** Sam's request: a two-credit overload, so the chair step is skipped (S05). */
export const values = samValues(2)

/** The time of the first step (I6): every other step is placed from it. */
export const T0 = 1_700_000_000_000

/** One hour and one day in milliseconds (AS-3). */
export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

/** Four hours: the idle period that the registrar step allows before a takeover (AS-3). */
export const IDLE_PERIOD = 4 * HOUR

/** The reason that Ana gives for the takeover (AS-3, I14). */
export const REASON = 'Lee is out until 10/19'

/** The reason that Lee gives for the undo (WF-5). */
export const UNDO_REASON = 'Back early, I keep my task'

/** The indexes of the story's steps after the setup. */
export const STEP = {
  start: 6,
  submit: 7,
  okaforClaim: 8,
  okaforApprove: 9,
  leeClaim: 10,
  takeover: 11,
  undo: 12,
} as const

/**
 * The clock of the story (I6, AS-3): the setup and the request run one minute
 * apart, Lee claims the registrar task, Ana takes it over two days later, and
 * Lee undoes the takeover an hour after that, within the flow's undo period
 * (WF-5).
 */
export const clock: StepClock = (index) => {
  if (index <= STEP.leeClaim) return T0 + index * 60_000
  if (index === STEP.takeover) return clock(STEP.leeClaim) + 2 * DAY
  return clock(STEP.takeover) + HOUR
}

/** The injected sources of step `index` (I6): the story clock and the `op-N` id. */
function depsAt(index: number): OperationDeps {
  return { clock: () => clock(index), ids: () => `op-${index + 1}` }
}

/** The state after the steps, replayed under the story clock (I6): the idle time and the undo period read the events' times. */
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

/** The golden path: the setup, then the request from the start to Lee's undo of the takeover. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Sam starts and submits; the submit routes to Dr. Okafor (ADR 0014).
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsAt(STEP.start), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAt(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: SAM },
    depsAt(STEP.submit)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dr. Okafor claims and approves: the chair step is skipped, so the request
  // routes to the registrar team (WF-1, AS-4).
  const okaforClaim = claim(instanceAt(steps), OKAFOR, 1, depsAt(STEP.okaforClaim))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAt(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    depsAt(STEP.okaforApprove)
  )
  if (okaforApprove.operation === undefined) throw new Error(okaforApprove.reason)
  steps.push(
    declared(okaforApprove.operation, {
      instanceId: INSTANCE_ID,
      version: 2,
      outcome: 'approve',
      values: {},
    })
  )

  // Lee claims the registrar task, then goes on vacation (S09, AS-2).
  const leeClaim = claim(instanceAt(steps), LEE, 3, depsAt(STEP.leeClaim))
  if (leeClaim.operation === undefined) throw new Error(leeClaim.reason)
  steps.push(declared(leeClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))

  // Two days later Ana takes the task over: Lee has been idle for longer than
  // the four hours the step allows (AS-3, WF-5). The notification to Lee
  // rides in the same operation (I2, SE-2).
  const taken = takeover(
    instanceAt(steps),
    ANA,
    REASON,
    clock(STEP.takeover),
    IDLE_PERIOD,
    4,
    stateAt(steps).log,
    depsAt(STEP.takeover)
  )
  if (taken.operation === undefined) throw new Error(taken.reason)
  steps.push(declared(taken.operation, { instanceId: INSTANCE_ID, reason: REASON, version: 4 }))

  // Lee, back early, undoes the takeover: a compensating event restores him
  // as the holder and never rewrites the takeover (WF-5, A2, I4).
  const log = stateAt(steps).log
  const takeoverSeq = log[log.length - 1].seq
  const undone = undoAction(
    instanceAt(steps),
    LEE,
    takeoverSeq,
    UNDO_REASON,
    5,
    {
      flow: SLUG,
      definition: definitionV1,
      log,
      grants: grantsOfPerson(LEE),
      now: clock(STEP.undo),
      undoPeriod: 24 * HOUR,
    },
    depsAt(STEP.undo)
  )
  if (undone.operation === undefined) throw new Error(undone.reason)
  // No side effect of the takeover already occurred, so the compensating
  // event carries an empty outbox; the step declares the payload as it is.
  steps.push({
    actor: LEE,
    type: undone.operation.type,
    payload: undone.operation.payload,
    intent: { instanceId: INSTANCE_ID, eventId: takeoverSeq, reason: UNDO_REASON, version: 5 },
  })
  return steps
}

export const golden = scenario({
  slug: 'takeover',
  flowSlug: SLUG,
  bootstrap,
  membership,
  clock,
  steps: goldenSteps(),
})

/**
 * What each step requires of its actor (I8): an assignee for a claim and a
 * takeover (AS-3), the holder with the outcome scope for a completion
 * (AC-4), and the previous holder or a flow owner for the undo (WF-5).
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
      return { actors: index === STEP.okaforClaim ? [OKAFOR] : [LEE, ANA, JORDAN] }
    case STEP_COMPLETED:
      return {
        scope: 'step.outcome:approve',
        resource: stepResource(ADVISOR_STEP),
        actors: [OKAFOR],
      }
    case STEP_TAKEN_OVER:
      // Any other assignee of the registrar step may take over from Lee (AS-3).
      return { actors: [ANA, JORDAN] }
    case EVENT_UNDONE:
      // Lee lost the task to Ana; he, Ana who took it, or Priya with
      // task.reassign may undo the takeover (WF-5).
      return { actors: [LEE, ANA, 'user:priya'] }
    default:
      throw new Error(`S10: step ${index + 1} has no requirement (${step.type})`)
  }
}

/** The registrar step of the story, for the tests. */
export const TAKEN_STEP = REGISTRAR_STEP

/**
 * The server state the interface path starts from (#269, S10): the request
 * at the registrar step, claimed by Lee at time 0.
 */
export function guiSeed(): State {
  return seedClaimed(seedApproved(seedSubmitted(exampleTeamState(), values), values), LEE)
}

/** The clock of the interface path (I6): two days after Lee's claim, one hour per step. */
export const guiClock: StepClock = (index) => T0 + 2 * DAY + index * HOUR

/**
 * The interface path of S10 (STORIES.md): the task shows "Claimed by Lee";
 * Ana takes it over with a reason; Lee, back early, undoes the takeover from
 * the timeline.
 */
function guiSteps(seed: State): readonly Step[] {
  const steps: Step[] = []
  const depsAt = (index: number): OperationDeps => ({
    clock: () => guiClock(index),
    ids: () => `op-${index + 1}`,
  })
  const instanceAt = () => {
    // The steps are placed by the gui clock (I6): the idle time and the undo
    // period read the events' times.
    let after = emptyState
    steps.forEach((step, index) => {
      after = apply(stepOperation(step, index, guiClock), after)
    })
    const log = [...seed.log, ...after.log].map((event, index) => ({
      ...event,
      seq: index + 1,
    }))
    const instance = instanceOf(log, INSTANCE_ID)
    if (instance === undefined) throw new Error('S10 gui: no instance')
    return { instance, log }
  }
  const held = instanceAt()
  const taken = takeover(
    held.instance,
    ANA,
    REASON,
    guiClock(0),
    IDLE_PERIOD,
    4,
    held.log,
    depsAt(0)
  )
  if (taken.operation === undefined) throw new Error(taken.reason)
  steps.push(declared(taken.operation, { instanceId: INSTANCE_ID, reason: REASON, version: 4 }))

  const takeoverSeq = seed.log.length + 1
  const after = instanceAt()
  const undone = undoAction(
    after.instance,
    LEE,
    takeoverSeq,
    UNDO_REASON,
    5,
    {
      flow: SLUG,
      definition: definitionV1,
      log: after.log,
      grants: grantsOfPerson(LEE),
      now: guiClock(1),
      undoPeriod: 24 * HOUR,
    },
    depsAt(1)
  )
  if (undone.operation === undefined) throw new Error(undone.reason)
  steps.push({
    actor: LEE,
    type: EVENT_UNDONE,
    payload: undone.operation.payload,
    intent: { instanceId: INSTANCE_ID, eventId: takeoverSeq, reason: UNDO_REASON, version: 5 },
  })
  return steps
}

export const guiGolden = scenario({
  slug: 'takeover',
  flowSlug: SLUG,
  bootstrap,
  membership,
  clock: guiClock,
  steps: guiSteps(guiSeed()),
  gui: [
    {
      // Ana sees who holds the task and since when, and takes it over.
      instance: INSTANCE_ID,
      actions: [
        {
          expectText: {
            selector: '[data-status-line]',
            text: 'Step 4 of 4: registrar is opened, in progress by user:lee.',
          },
        },
        { type: { selector: '[data-takeover-reason]', text: REASON } },
        { click: '[data-takeover]' },
        {
          expectText: {
            selector: '[data-status-line]',
            text: 'Step 4 of 4: registrar is opened, in progress by user:ana.',
          },
        },
      ],
    },
    {
      // Lee undoes the takeover from the timeline, with a reason (WF-5).
      instance: INSTANCE_ID,
      actions: [
        { expectSelector: '[data-timeline-type="step.taken-over@1"]' },
        { type: { selector: '[data-undo-reason]', text: UNDO_REASON } },
        { click: '[data-undo-action]' },
        {
          expectText: {
            selector: '[data-status-line]',
            text: 'Step 4 of 4: registrar is opened, in progress by user:lee.',
          },
        },
        { expectSelector: '[data-timeline-type="step.taken-over@1"][data-timeline-undone]' },
      ],
    },
  ],
})
