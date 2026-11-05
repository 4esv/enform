import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { STEP_SENT_BACK, sendBack } from '../../engine/sendBack.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  declared,
  definitionV1,
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
  REGISTRAR_STEP,
  REQUEST_STEP,
  SAM,
  SLUG,
  samValues,
  setupSteps,
  stepResource,
} from '../example-flow.js'

// S11: send back for revision (STORIES.md). Dr. Okafor holds Sam's request at
// the advisor step and sends it back to the request form with a note (WF-2,
// WF-3): the instance becomes a draft again (ADR 0014), Sam corrects it and
// submits it a second time, and the request reaches the advisor step as
// revision 2. Dr. Okafor approves, and at the registrar step Jordan, who
// holds `step.outcome:send_back` only (S02, AC-4), sends it back to the
// advisor step with a note. Every step after the setup is a client intent
// that the server resolves (ADR 0010). The path is deterministic (I6).

/** Sam's request: a two-credit overload, so the chair step is skipped (S05). */
export const values = samValues(2)

/** The note that Dr. Okafor attaches to the send back (WF-3, SE-2). */
export const COMMENT = 'Attach your degree audit'

/** The note that Jordan attaches to his send back at the registrar step (WF-3). */
export const JORDAN_COMMENT = 'Confirm the advisor signature'

/** The correction that Sam makes before he submits again (WF-3). */
export const CORRECTION = { summary: 'three extra credits, degree audit attached' }

/** The indexes of the story's steps after the setup. */
export const STEP = {
  start: 6,
  submit: 7,
  okaforClaim: 8,
  okaforSendBack: 9,
  resubmit: 10,
  okaforClaimAgain: 11,
  okaforApprove: 12,
  jordanClaim: 13,
  jordanSendBack: 14,
} as const

/** The golden path: the setup, then the request, its send back, its resubmission, and Jordan's send back. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)
  const okafor = grantsOfPerson(OKAFOR)
  const okaforContext = (actorValues = values) => ({
    flow: SLUG,
    definition: definitionV1,
    grants: okafor,
    resolve: directory(actorValues),
  })

  // Sam starts and submits; the submit routes to Dr. Okafor (ADR 0014).
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(STEP.start), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: SAM },
    depsFor(STEP.submit)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dr. Okafor claims the advisor task and sends the request back to the
  // request form with a note: the instance is a draft again, revision 2 of
  // the request step, and the note to Sam rides in the same commit (WF-3,
  // ADR 0014, I2, SE-2).
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsFor(STEP.okaforClaim))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const sentBack = sendBack(
    instanceAfter(steps),
    OKAFOR,
    REQUEST_STEP,
    COMMENT,
    2,
    okaforContext(),
    depsFor(STEP.okaforSendBack)
  )
  if (sentBack.operation === undefined) throw new Error(sentBack.reason)
  steps.push(
    declared(sentBack.operation, {
      instanceId: INSTANCE_ID,
      to: REQUEST_STEP,
      comment: COMMENT,
      version: 2,
    })
  )

  // Sam corrects the summary and submits again: the request goes to the
  // advisor step again, and the timeline keeps both revisions (WF-3).
  const corrected = { ...values, ...CORRECTION }
  const resubmitted = submitInstance(
    instanceAfter(steps),
    SAM,
    CORRECTION,
    3,
    {
      flow: SLUG,
      definition: definitionV1,
      resolve: directory(corrected),
      grants: sam,
      owner: SAM,
    },
    depsFor(STEP.resubmit)
  )
  if (resubmitted.operation === undefined) throw new Error(resubmitted.reason)
  steps.push(
    declared(resubmitted.operation, { instanceId: INSTANCE_ID, version: 3, values: CORRECTION })
  )

  // Dr. Okafor claims again and approves: the chair step is skipped for two
  // credits, so the request routes to the registrar team (WF-1, AS-4).
  const claimAgain = claim(instanceAfter(steps), OKAFOR, 4, depsFor(STEP.okaforClaimAgain))
  if (claimAgain.operation === undefined) throw new Error(claimAgain.reason)
  steps.push(declared(claimAgain.operation, { instanceId: INSTANCE_ID, expectedVersion: 4 }))
  const approved = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    5,
    { ...okaforContext(corrected), owner: SAM },
    depsFor(STEP.okaforApprove)
  )
  if (approved.operation === undefined) throw new Error(approved.reason)
  steps.push(
    declared(approved.operation, {
      instanceId: INSTANCE_ID,
      version: 5,
      outcome: 'approve',
      values: {},
    })
  )

  // Jordan, a registrar reviewer, claims the registrar task and sends it back
  // to the advisor step: he may send back and may not approve (S02, AC-4).
  const jordanClaim = claim(instanceAfter(steps), JORDAN, 6, depsFor(STEP.jordanClaim))
  if (jordanClaim.operation === undefined) throw new Error(jordanClaim.reason)
  steps.push(declared(jordanClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 6 }))
  const jordanSentBack = sendBack(
    instanceAfter(steps),
    JORDAN,
    ADVISOR_STEP,
    JORDAN_COMMENT,
    7,
    {
      flow: SLUG,
      definition: definitionV1,
      grants: grantsOfPerson(JORDAN),
      resolve: directory(corrected),
    },
    depsFor(STEP.jordanSendBack)
  )
  if (jordanSentBack.operation === undefined) throw new Error(jordanSentBack.reason)
  steps.push(
    declared(jordanSentBack.operation, {
      instanceId: INSTANCE_ID,
      to: ADVISOR_STEP,
      comment: JORDAN_COMMENT,
      version: 7,
    })
  )
  return steps
}

/** The injected sources of step `index` (I6): the golden step clock and the `op-N` id. */
function depsFor(index: number): { clock: () => number; ids: () => string } {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

export const golden = scenario({
  slug: 'send-back',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/**
 * What each step requires of its actor (I8): the starter for a submit, an
 * assignee for a claim, the holder with `step.outcome:send_back` for a send
 * back and with `step.outcome:approve` for an approval (AC-4).
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
      return { actors: index === STEP.jordanClaim ? [LEE, ANA, JORDAN] : [OKAFOR] }
    case STEP_SENT_BACK:
      return index === STEP.jordanSendBack
        ? {
            scope: 'step.outcome:send_back',
            resource: stepResource(REGISTRAR_STEP),
            actors: [JORDAN],
          }
        : {
            scope: 'step.outcome:send_back',
            resource: stepResource(ADVISOR_STEP),
            actors: [OKAFOR],
          }
    case STEP_COMPLETED:
      return {
        scope: 'step.outcome:approve',
        resource: stepResource(ADVISOR_STEP),
        actors: [OKAFOR],
      }
    default:
      throw new Error(`S11: step ${index + 1} has no requirement (${step.type})`)
  }
}
