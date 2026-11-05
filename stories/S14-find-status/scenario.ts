import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { release } from '../../engine/reassign.js'
import { STEP_SENT_BACK, sendBack } from '../../engine/sendBack.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { TASK_RELEASED } from '../../engine/undo.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  declared,
  definitionV1,
  depsFor,
  directory,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  membership,
  OKAFOR,
  PRIYA,
  REGISTRAR_STEP,
  SAM,
  SLUG,
  samValues,
  setupSteps,
  stepResource,
} from '../example-flow.js'

// S14: find the status of a submission (STORIES.md). Sam's request is
// routed to the registrar step after Dr. Okafor's approval, with the chair
// step skipped for a two-credit overload (S05). Ana claims the registrar
// task, so the status says "opened, in progress"; she releases it, so it
// says "waiting to be opened" again (VT-1, VT-2). Jordan, the reviewer,
// claims it and sends the request back to the advisor with a note (WF-3,
// S11). Sam reads the status and the tracker of his own instance, and not the
// note of the people who act on the advisor step, nor a value that a scope
// guards (VT-3, VT-4, I8). Every step after the setup is a client intent that
// the server resolves (ADR 0010). The path is deterministic (I6).

/** Sam's request: a two-credit overload, so the chair step is skipped (S05, WF-1). */
export const values = samValues(2)

/** The note that Jordan records when he sends the registrar task back (WF-3, S11). */
export const SEND_BACK_COMMENT = 'The advisor signature is missing'

/** The golden path: the setup, the request to the registrar, a claim, a release, a claim and a send back. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Sam starts and submits (S06, ADR 0014): the request reaches Dr. Okafor.
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

  // Dr. Okafor claims and approves: the chair step is skipped and the
  // registrar team gets the task (S05, WF-1, AS-4).
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

  // Ana claims the registrar task, then releases it to the pool (AS-2, WF-5).
  const anaClaim = claim(instanceAfter(steps), ANA, 3, depsFor(10))
  if (anaClaim.operation === undefined) throw new Error(anaClaim.reason)
  steps.push(declared(anaClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))
  const released = release(
    instanceAfter(steps),
    ANA,
    undefined,
    4,
    { flow: SLUG, grants: grantsOfPerson(ANA) },
    depsFor(11)
  )
  if (released.operation === undefined) throw new Error(released.reason)
  steps.push(declared(released.operation, { instanceId: INSTANCE_ID, version: 4 }))

  // Jordan, the reviewer, claims the task and sends the request back to the
  // advisor with a note (WF-3, S11, AC-4).
  const jordanClaim = claim(instanceAfter(steps), JORDAN, 5, depsFor(12))
  if (jordanClaim.operation === undefined) throw new Error(jordanClaim.reason)
  steps.push(declared(jordanClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 5 }))
  const sent = sendBack(
    instanceAfter(steps),
    JORDAN,
    ADVISOR_STEP,
    SEND_BACK_COMMENT,
    6,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(JORDAN), resolve },
    depsFor(13)
  )
  if (sent.operation === undefined) throw new Error(sent.reason)
  steps.push(
    declared(sent.operation, {
      instanceId: INSTANCE_ID,
      to: ADVISOR_STEP,
      comment: SEND_BACK_COMMENT,
      version: 6,
    })
  )
  return steps
}

export const golden = scenario({
  slug: 'find-status',
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
  anaClaim: 10,
  anaRelease: 11,
  jordanClaim: 12,
  jordanSendBack: 13,
} as const

/**
 * What each step requires of its actor (I8), for the Actor operator: an
 * assignee claims, the holder or a flow owner with task.reassign releases,
 * and the holder with step.outcome:send_back sends back (AS-2, AC-4, WF-5).
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
    case TASK_RELEASED:
      return { actors: [ANA, PRIYA] }
    case STEP_SENT_BACK:
      return {
        scope: 'step.outcome:send_back',
        resource: stepResource(REGISTRAR_STEP),
        actors: [JORDAN],
      }
    default:
      throw new Error(`S14: step ${index + 1} has no requirement (${step.type})`)
  }
}
