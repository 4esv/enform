import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { apply, type State } from '../../engine/apply.js'
import { DEFINITION_CHANGED, type FlowDefinition, parse } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED, type Flow } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import { instanceOf } from '../../engine/instances.js'
import type { Operation } from '../../engine/operation.js'
import {
  ASSIGNMENT_EMAIL,
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { CONNECTOR_CALLED } from '../../engine/timeline.js'
import { EVENT_UNDONE, SENT_OUTCOME, undoAction } from '../../engine/undo.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { goldenClock, type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  CHAIR_STEP,
  CHAIRS_GROUP,
  declared,
  depsFor,
  directory,
  exampleTeamState,
  FLOW,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  membership,
  OKAFOR,
  PRIYA,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  SAM,
  SLUG,
  samValues,
  seedApproved,
  seedClaimed,
  seedDeps,
  seedSubmitted,
  setupSteps,
  stateAfter,
  stepResource,
} from '../example-flow.js'

// S16: undo a mistake (STORIES.md). Lee approves the wrong course-overload
// request at the registrar step, which assigns the archive task to Priya and
// emails her (SE-1, I2); the worker sends the email and records the call
// (I13). Lee undoes the approval: the undo is a compensating event (WF-5, A2,
// D6), the approval stays in the log (I4), the email that already went out
// is marked "Already sent" and Priya, whom it reached, is notified (S16,
// A2). The flow marks the archive step final: once Priya recorded the
// decision, nothing on the instance can be undone (S16, WF-5). Every step
// after the setup is a client intent that the server resolves (ADR 0010),
// except the worker's record of the call, which is the occurrence it is. The
// path is deterministic (I6).

/** The archive step: Priya records the decision after the registrar (WF-1). */
export const ARCHIVE_STEP = 'archive'

/** The outcome that records the decision on the archive step (WF-2). */
export const RECORD = 'record'

/**
 * The flow of the story: the example flow with an archive step after the
 * registrar, which the flow marks final (S16, WF-5): once an instance
 * completed it, no action on the instance can be undone.
 */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "finalStep": "${ARCHIVE_STEP}",
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
      "outcomes": ["approve", "send_back"]
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
    },
    {
      "key": "${ARCHIVE_STEP}",
      "targets": [{ "user": "${PRIYA}" }],
      "outcomes": ["${RECORD}"]
    }
  ]
}
`)

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

/** The grants of the cast, and Priya's outcome on the archive step (S02, AC-4). */
export const storyGrants = [
  ...bootstrap,
  { principal: PRIYA, scopes: [`step.outcome:${RECORD}`], resource: stepResource(ARCHIVE_STEP) },
]

/** Sam's request: a two-credit overload, so the chair step is skipped (S05). */
export const values = samValues(2)

/** The reason that Lee gives for the undo (STORIES.md, S16). */
export const REASON = 'Approved the wrong request'

/** The undo period of the flow (WF-5): the server default of twenty-four hours. */
export const UNDO_PERIOD = 24 * 3_600_000

/** The worker, which records the connector calls that it ran (SE-1, I13). */
export const SYSTEM = 'system'

/** The indexes of the story's steps after the setup, for the requirements and the tests. */
export const STEP = {
  start: 6,
  submit: 7,
  okaforClaim: 8,
  okaforApprove: 9,
  leeClaim: 10,
  leeApprove: 11,
  emailSent: 12,
  leeUndo: 13,
  leeApproveAgain: 14,
  priyaClaim: 15,
  priyaRecord: 16,
} as const

/** The record of the worker's call for the email that Lee's approval sent (I13, A2). */
export const sentCall = {
  instanceId: INSTANCE_ID,
  operation: ASSIGNMENT_EMAIL,
  time: goldenClock(STEP.emailSent),
  outcome: SENT_OUTCOME,
}

/** The grants that apply to one person of the cast in this story (AC-1). */
export function storyGrantsOf(person: string): readonly (typeof storyGrants)[number][] {
  return [...grantsOfPerson(person), ...storyGrants.filter((grant) => grant.principal === person)]
}

/**
 * The step that declares an undo (ADR 0010): the engine records the outbox
 * of a compensating event even when it notifies nobody, so the declared
 * payload keeps the empty outbox that `declared` would drop.
 */
function declaredUndo(operation: Operation, intent: Readonly<Record<string, unknown>>): Step {
  const step = declared(operation, intent)
  return step.outbox === undefined ? { ...step, payload: { ...step.payload, outbox: [] } } : step
}

/** The golden path: the setup, the request to the registrar, the wrong approval, its undo, the right one and the record. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps(definition)]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Sam starts and submits (S06, ADR 0014); Dr. Okafor approves; the chair
  // step is skipped and the registrar team gets the task (S05, S09).
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(6), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: sam, owner: SAM },
    depsFor(7)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsFor(8))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    depsFor(9)
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

  // Lee claims the registrar task and approves the wrong request: the
  // approval assigns the archive task to Priya and emails her (SE-1, I2).
  const leeClaim = claim(instanceAfter(steps), LEE, 3, depsFor(10))
  if (leeClaim.operation === undefined) throw new Error(leeClaim.reason)
  steps.push(declared(leeClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))
  const leeContext = {
    flow: SLUG,
    definition,
    grants: grantsOfPerson(LEE),
    resolve,
    owner: SAM,
  }
  const wrong = complete(instanceAfter(steps), LEE, 'approve', {}, 4, leeContext, depsFor(11))
  if (wrong.operation === undefined) throw new Error(wrong.reason)
  steps.push(
    declared(wrong.operation, {
      instanceId: INSTANCE_ID,
      version: 4,
      outcome: 'approve',
      values: {},
    })
  )

  // The worker sent the email and records the call (I13): the log states
  // what already occurred.
  steps.push({ actor: SYSTEM, type: CONNECTOR_CALLED, payload: sentCall })

  // Lee undoes the approval (WF-5, A2, D6): the compensating event marks the
  // email "Already sent" and notifies Priya.
  const undone = undoAction(
    instanceAfter(steps),
    LEE,
    STEP.leeApprove + 1,
    REASON,
    5,
    {
      flow: SLUG,
      definition,
      log: stateAfter(steps).log,
      grants: grantsOfPerson(LEE),
      now: goldenClock(13),
      undoPeriod: UNDO_PERIOD,
    },
    depsFor(13)
  )
  if (undone.operation === undefined) throw new Error(undone.reason)
  steps.push(
    declaredUndo(undone.operation, {
      instanceId: INSTANCE_ID,
      eventId: STEP.leeApprove + 1,
      reason: REASON,
      version: 5,
    })
  )

  // Lee approves the right request; Priya claims the archive task and
  // records the decision, the final step of the flow (S16, WF-5).
  const right = complete(instanceAfter(steps), LEE, 'approve', {}, 6, leeContext, depsFor(14))
  if (right.operation === undefined) throw new Error(right.reason)
  steps.push(
    declared(right.operation, {
      instanceId: INSTANCE_ID,
      version: 6,
      outcome: 'approve',
      values: {},
    })
  )
  const priyaClaim = claim(instanceAfter(steps), PRIYA, 7, depsFor(15))
  if (priyaClaim.operation === undefined) throw new Error(priyaClaim.reason)
  steps.push(declared(priyaClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 7 }))
  const recorded = complete(
    instanceAfter(steps),
    PRIYA,
    RECORD,
    {},
    8,
    { flow: SLUG, definition, grants: storyGrantsOf(PRIYA), resolve, owner: SAM },
    depsFor(16)
  )
  if (recorded.operation === undefined) throw new Error(recorded.reason)
  steps.push(
    declared(recorded.operation, {
      instanceId: INSTANCE_ID,
      version: 8,
      outcome: RECORD,
      values: {},
    })
  )
  return steps
}

export const golden = scenario({
  slug: 'undo',
  flowSlug: SLUG,
  bootstrap: storyGrants,
  membership,
  steps: goldenSteps(),
})

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * actor of an action or a flow owner with task.reassign undoes it (WF-5);
 * the worker alone records a call.
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
      if (index === STEP.okaforClaim) return { actors: [OKAFOR] }
      if (index === STEP.priyaClaim) return { actors: [PRIYA] }
      return { actors: [LEE, ANA, JORDAN] }
    case STEP_COMPLETED:
      if (index === STEP.okaforApprove) {
        return {
          scope: 'step.outcome:approve',
          resource: stepResource(ADVISOR_STEP),
          actors: [OKAFOR],
        }
      }
      if (index === STEP.priyaRecord) {
        return {
          scope: `step.outcome:${RECORD}`,
          resource: stepResource(ARCHIVE_STEP),
          actors: [PRIYA],
        }
      }
      return {
        scope: 'step.outcome:approve',
        resource: stepResource(REGISTRAR_STEP),
        actors: [LEE],
      }
    case CONNECTOR_CALLED:
      return { actors: [SYSTEM] }
    case EVENT_UNDONE:
      return { actors: [LEE, PRIYA] }
    default:
      throw new Error(`S16: step ${index + 1} has no requirement (${step.type})`)
  }
}

/**
 * The server state the interface path starts from (#269, S16): Lee approved
 * the wrong request at the registrar step, the archive task reached Priya,
 * and the worker recorded that her email went out (I13).
 */
export function guiSeed(): State {
  const on = { flow, definition }
  let state = seedClaimed(
    seedApproved(seedSubmitted(exampleTeamState(definition), values, on), values, on),
    LEE
  )
  const held = instanceOf(state.log, INSTANCE_ID)
  if (held === undefined) throw new Error('S16 gui: no instance')
  const wrong = complete(
    held,
    LEE,
    'approve',
    {},
    held.version ?? 0,
    { flow: SLUG, definition, grants: grantsOfPerson(LEE), resolve: directory(values), owner: SAM },
    seedDeps('seed-lee-approve')
  )
  if (wrong.operation === undefined) throw new Error(wrong.reason)
  state = apply(wrong.operation, state)
  return apply(
    {
      id: 'seed-email-sent',
      type: CONNECTOR_CALLED,
      at: 0,
      actor: SYSTEM,
      payload: { ...sentCall, time: 0 },
    },
    state
  )
}

/**
 * The interface path of S16 (STORIES.md): Undo stays available in the
 * timeline; Lee undoes the approval with a reason, the timeline marks the
 * email that already went out "Already sent", Lee approves the right
 * request, and Priya records the decision at the final step.
 */
function guiSteps(seed: State): readonly Step[] {
  const steps: Step[] = []
  const resolve = directory(values)
  const instanceAt = () => {
    const log = [...seed.log, ...stateAfter(steps).log].map((event, index) => ({
      ...event,
      seq: index + 1,
    }))
    const instance = instanceOf(log, INSTANCE_ID)
    if (instance === undefined) throw new Error('S16 gui: no instance')
    return { instance, log }
  }
  // The approval is the seed's last event but one: the call record follows it.
  const approveSeq = seed.log.length - 1
  const before = instanceAt()
  const undone = undoAction(
    before.instance,
    LEE,
    approveSeq,
    REASON,
    5,
    {
      flow: SLUG,
      definition,
      log: before.log,
      grants: grantsOfPerson(LEE),
      now: goldenClock(0),
      undoPeriod: UNDO_PERIOD,
    },
    depsFor(0)
  )
  if (undone.operation === undefined) throw new Error(undone.reason)
  steps.push(
    declaredUndo(undone.operation, {
      instanceId: INSTANCE_ID,
      eventId: approveSeq,
      reason: REASON,
      version: 5,
    })
  )
  const leeContext = { flow: SLUG, definition, grants: grantsOfPerson(LEE), resolve, owner: SAM }
  const right = complete(instanceAt().instance, LEE, 'approve', {}, 6, leeContext, depsFor(1))
  if (right.operation === undefined) throw new Error(right.reason)
  steps.push(
    declared(right.operation, {
      instanceId: INSTANCE_ID,
      version: 6,
      outcome: 'approve',
      values: {},
    })
  )
  const priyaClaim = claim(instanceAt().instance, PRIYA, 7, depsFor(2))
  if (priyaClaim.operation === undefined) throw new Error(priyaClaim.reason)
  steps.push(declared(priyaClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 7 }))
  const recorded = complete(
    instanceAt().instance,
    PRIYA,
    RECORD,
    {},
    8,
    { flow: SLUG, definition, grants: storyGrantsOf(PRIYA), resolve, owner: SAM },
    depsFor(3)
  )
  if (recorded.operation === undefined) throw new Error(recorded.reason)
  steps.push(
    declared(recorded.operation, {
      instanceId: INSTANCE_ID,
      version: 8,
      outcome: RECORD,
      values: {},
    })
  )
  return steps
}

export const guiGolden = scenario({
  slug: 'undo',
  flowSlug: SLUG,
  bootstrap: storyGrants,
  membership,
  steps: guiSteps(guiSeed()),
  gui: [
    {
      // Lee undoes the approval from the timeline with a reason; the email
      // that already went out is marked "Already sent" (A2).
      instance: INSTANCE_ID,
      actions: [
        { expectSelector: '[data-timeline-type="step.completed@1"] [data-undo-action]' },
        { type: { selector: '[data-undo-reason]', text: REASON } },
        { click: '[data-undo-action]' },
        { expectSelector: '[data-timeline-type="step.completed@1"][data-timeline-undone]' },
        { expectText: { selector: '[data-already-sent]', text: 'Already sent' } },
        {
          expectText: {
            selector: '[data-status-line]',
            text: 'Step 4 of 5: registrar is opened, in progress by user:lee.',
          },
        },
      ],
    },
    {
      instance: INSTANCE_ID,
      actions: [
        { click: '[data-outcome="approve"]' },
        { expectSelector: '[data-tracker-step="archive"][data-tracker-state="unopened"]' },
      ],
    },
    { instance: INSTANCE_ID, actions: [{ click: '[data-claim]' }, { expect: 'Claimed' }] },
    {
      // The final step: once recorded, nothing on the instance can be undone (WF-5).
      instance: INSTANCE_ID,
      actions: [
        { click: `[data-outcome="${RECORD}"]` },
        { expectText: { selector: '[data-status-line]', text: 'Done: all 5 steps completed.' } },
        { expectText: { selector: '[data-undo-count]', text: '0' } },
      ],
    },
  ],
})
