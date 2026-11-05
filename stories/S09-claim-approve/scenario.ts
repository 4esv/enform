import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import type { State } from '../../engine/apply.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { instanceOf } from '../../engine/instances.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { EVENT_UNDONE, undoAction } from '../../engine/undo.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { goldenClock, type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  declared,
  definitionV1,
  depsFor,
  directory,
  exampleTeamState,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  membership,
  OKAFOR,
  REGISTRAR_STEP,
  SAM,
  SLUG,
  samValues,
  seedApproved,
  seedSubmitted,
  setupSteps,
  stateAfter,
  stepResource,
} from '../example-flow.js'

// S09: claim and approve (STORIES.md). Sam's request reaches the registrar
// step, whose team target resolves to Lee, Ana and Jordan (AS-4). The task
// shows in their Available tab; the first to claim it owns it (AS-2). Lee
// claims it and completes it with approve, which his `step.outcome:approve`
// grant authorizes and no other outcome does (AC-4), and the flow is done.
// Every step after the setup is a client intent that the server resolves
// (ADR 0010): the start and the submit by Sam, Dr. Okafor's claim and
// approval of the advisor step, which skips the chair step for a two-credit
// overload (S05), and Lee's claim and approval. The path is deterministic
// (I6): it reads no clock and no random source, and the directory is injected.

/** Sam's request: a two-credit overload, so the chair step is skipped (S05, WF-1). */
export const values = samValues(2)

/** The golden path: the setup, then the request from the start to Lee's approval. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Sam starts a draft with his answers and submits it: the submit routes
  // the request to the advisor step and emails Dr. Okafor (ADR 0014, SE-1).
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(6), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: SAM },
    depsFor(7)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dr. Okafor claims the advisor task and approves it. The chair step is
  // skipped for two credits, so the request routes to the registrar team and
  // emails its three members (WF-1, AS-4).
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsFor(8))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
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

  // Lee claims the registrar task and approves it: the registrar step is the
  // last, so the instance is done (S09).
  const leeClaim = claim(instanceAfter(steps), LEE, 3, depsFor(10))
  if (leeClaim.operation === undefined) throw new Error(leeClaim.reason)
  steps.push(declared(leeClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))
  const leeApprove = complete(
    instanceAfter(steps),
    LEE,
    'approve',
    {},
    4,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(LEE), resolve, owner: SAM },
    depsFor(11)
  )
  if (leeApprove.operation === undefined) throw new Error(leeApprove.reason)
  steps.push(
    declared(leeApprove.operation, {
      instanceId: INSTANCE_ID,
      version: 4,
      outcome: 'approve',
      values: {},
    })
  )
  return steps
}

export const golden = scenario({
  slug: 'claim-approve',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup, for the requirements and the tests. */
export const STEP = {
  start: 6,
  submit: 7,
  okaforClaim: 8,
  okaforApprove: 9,
  leeClaim: 10,
  leeApprove: 11,
} as const

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * build scope for the flow, org.teams for the team, instance.start for the
 * start, the starter for the submit, an assignee for a claim, and the holder
 * with the outcome scope for a completion (AS-2, AC-4).
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
      return index === STEP.okaforApprove
        ? { scope: 'step.outcome:approve', resource: stepResource(ADVISOR_STEP), actors: [OKAFOR] }
        : { scope: 'step.outcome:approve', resource: stepResource(REGISTRAR_STEP), actors: [LEE] }
    default:
      throw new Error(`S09: step ${index + 1} has no requirement (${step.type})`)
  }
}

/**
 * The server state the interface path starts from (#269, S09): the flow, the
 * registrar team, and Sam's request approved by Dr. Okafor, so the registrar
 * task waits for Lee, Ana and Jordan.
 */
export function guiSeed(): State {
  return seedApproved(seedSubmitted(exampleTeamState(), values), values)
}

/** The reason the notification's Undo records (S16, WF-5). */
export const TOAST_UNDO_REASON = 'Undone from the notification'

/**
 * The interface path of S09 (STORIES.md): Lee opens the registrar task from
 * his inbox and claims it; the notification offers Undo, he takes it back,
 * claims again and approves. Each gui step maps to the engine step at the
 * same index, on the seeded state.
 */
function guiSteps(seed: State): readonly Step[] {
  const steps: Step[] = []
  const resolve = directory(values)
  const after = (): State => stateAfter(steps)
  const instanceAt = () => {
    const log = [...seed.log, ...after().log].map((event, index) => ({
      ...event,
      seq: index + 1,
    }))
    const instance = instanceOf(log, INSTANCE_ID)
    if (instance === undefined) throw new Error('S09 gui: no instance')
    return { instance, log }
  }
  const first = instanceAt()
  const leeClaim = claim(first.instance, LEE, first.instance.version ?? 0, depsFor(0))
  if (leeClaim.operation === undefined) throw new Error(leeClaim.reason)
  steps.push(declared(leeClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))

  // The notification's Undo: the claim is the newest action, Lee made it (WF-5).
  const claimed = instanceAt()
  const claimSeq = seed.log.length + 1
  const undone = undoAction(
    claimed.instance,
    LEE,
    claimSeq,
    TOAST_UNDO_REASON,
    4,
    {
      flow: SLUG,
      definition: definitionV1,
      log: claimed.log,
      grants: grantsOfPerson(LEE),
      now: goldenClock(1),
      undoPeriod: 24 * 3_600_000,
    },
    depsFor(1)
  )
  if (undone.operation === undefined) throw new Error(undone.reason)
  steps.push({
    actor: LEE,
    type: EVENT_UNDONE,
    payload: undone.operation.payload,
    intent: { instanceId: INSTANCE_ID, eventId: claimSeq, reason: TOAST_UNDO_REASON, version: 4 },
  })

  const again = instanceAt()
  const leeClaimAgain = claim(again.instance, LEE, 5, depsFor(2))
  if (leeClaimAgain.operation === undefined) throw new Error(leeClaimAgain.reason)
  steps.push(declared(leeClaimAgain.operation, { instanceId: INSTANCE_ID, expectedVersion: 5 }))
  const held = instanceAt()
  const leeApprove = complete(
    held.instance,
    LEE,
    'approve',
    {},
    6,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(LEE), resolve, owner: SAM },
    depsFor(3)
  )
  if (leeApprove.operation === undefined) throw new Error(leeApprove.reason)
  steps.push(
    declared(leeApprove.operation, {
      instanceId: INSTANCE_ID,
      version: 6,
      outcome: 'approve',
      values: {},
    })
  )
  return steps
}

export const guiGolden = scenario({
  slug: 'claim-approve',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: guiSteps(guiSeed()),
  gui: [
    {
      // Lee claims the registrar task; the notification offers Undo (S16).
      instance: INSTANCE_ID,
      actions: [
        {
          expectText: {
            selector: '[data-status-line]',
            text: 'Step 4 of 4: registrar is waiting to be opened.',
          },
        },
        { click: '[data-claim]' },
        { expectText: { selector: '[data-toast]', text: 'Claimed. Undo.' } },
      ],
    },
    {
      // Lee takes the claim back from the notification.
      instance: INSTANCE_ID,
      actions: [
        { click: '[data-claim]' },
        { expectEvents: 1 },
        { click: '[data-toast-undo]' },
        { expectSelector: '[data-tracker-step="registrar"][data-tracker-state="unopened"]' },
      ],
    },
    {
      instance: INSTANCE_ID,
      actions: [
        { click: '[data-claim]' },
        {
          expectText: {
            selector: '[data-status-line]',
            text: 'Step 4 of 4: registrar is opened, in progress by user:lee.',
          },
        },
      ],
    },
    {
      // Approve: the last step, so the instance is done and the notification offers Undo.
      instance: INSTANCE_ID,
      actions: [
        { click: '[data-outcome="approve"]' },
        { expectText: { selector: '[data-toast]', text: 'Approved. Undo.' } },
        { expectText: { selector: '[data-status-line]', text: 'Done: all 4 steps completed.' } },
      ],
    },
  ],
})
