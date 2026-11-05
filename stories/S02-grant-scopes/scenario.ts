import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import type { Grant } from '../../engine/authorize.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { addGrant, GRANT_CHANGE_TYPE, revokeGrant } from '../../engine/grants.js'
import { STEP_SENT_BACK, sendBack } from '../../engine/sendBack.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { grantsApplying } from '../../tools/harness/directory.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  CHAIR_STEP,
  CHAIRS_GROUP,
  DANA,
  declared,
  definitionV1,
  depsFor,
  directory,
  FLOW,
  flow,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  membership,
  OKAFOR,
  PRIYA,
  REGISTRAR_STEP,
  REQUEST_STEP,
  SAM,
  SLUG,
  STUDENTS_GROUP,
  samValues,
  setupSteps,
  stateAfter,
  stepResource,
} from '../example-flow.js'

// S02: Dana grants access by scope (STORIES.md). Every grant is one
// attributed `config.grant.changed@1` intent that the server resolves (AC-2,
// I14, ADR 0010): the engine authorizes `org.grants` on `org` (AC-1, I8) and
// derives the grant set from the log (I4). The grants of the cast are the
// story's own steps here, not the installation's: the only grants before
// the story are Dana's, the first administrator's. Jordan holds only
// `step.outcome:send_back` on the registrar step, so once Sam's request
// reaches it he may claim it and send it back, and an approval is refused
// (AC-4). A revoke is the same attributed change in the other direction. The
// path is deterministic (I6): it reads no clock and no random source.

/** The installation before the story: Dana, the first administrator (STORIES.md, Cast). */
export const bootstrap: readonly Grant[] = [
  { principal: DANA, scopes: ['org.grants', 'org.teams', 'org.impersonate'], resource: 'org' },
  { principal: DANA, scopes: ['flow.build'], resource: '*' },
]

/** The grants that Dana adds in the golden path, in the order of the story (S02). */
export const grants: readonly Grant[] = [
  { principal: `group:${STUDENTS_GROUP}`, scopes: ['instance.start'], resource: FLOW },
  {
    principal: LEE,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: stepResource(REGISTRAR_STEP),
  },
  {
    principal: ANA,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: stepResource(REGISTRAR_STEP),
  },
  {
    principal: `group:${CHAIRS_GROUP}`,
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: stepResource(CHAIR_STEP),
  },
  { principal: JORDAN, scopes: ['step.outcome:send_back'], resource: stepResource(REGISTRAR_STEP) },
  {
    principal: PRIYA,
    scopes: ['flow.edit', 'flow.dryrun', 'instance.read', 'instance.timeline', 'task.reassign'],
    resource: FLOW,
  },
  {
    principal: OKAFOR,
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: stepResource(ADVISOR_STEP),
  },
]

/** The grant that Dana revokes at the end: Ana keeps approve and loses reject (AC-2). */
export const revoked: Grant = {
  principal: ANA,
  scopes: ['step.outcome:reject'],
  resource: stepResource(REGISTRAR_STEP),
}

/** Sam's request: a two-credit overload, so the chair step is skipped (S05, WF-1). */
export const values = samValues(2)

/** Jordan's note to Sam (WF-3). */
export const COMMENT = 'Attach your degree audit'

/** The grants that apply to one person at one point of the story (AC-1): read from the log and the bootstrap. */
export function grantsHeld(steps: readonly Step[], person: string): readonly Grant[] {
  return grantsApplying(stateAfter(steps).log, person, bootstrap, membership)
}

/** One grant intent: Dana records the grant as an attributed change (I14). */
function grantStep(grant: Grant, index: number): Step {
  const intent = { principal: grant.principal, scopes: grant.scopes, resource: grant.resource }
  return declared(addGrant(grant, DANA, depsFor(index)), intent)
}

/** The golden path: the setup, the grants, Sam's request to the registrar step, Jordan's send back, a revoke. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  for (const grant of grants) steps.push(grantStep(grant, steps.length))
  const resolve = directory(values)

  // Sam starts and submits through the All-Students grant (AC-1, ID-4): the
  // submit routes the request to Dr. Okafor (ADR 0014, SE-1).
  const sam = grantsHeld(steps, SAM)
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(steps.length), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: PRIYA },
    depsFor(steps.length)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dr. Okafor claims and approves; the chair step is skipped for two
  // credits, so the request reaches the registrar team (WF-1, AS-4).
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsFor(steps.length))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    2,
    {
      flow: SLUG,
      definition: definitionV1,
      grants: grantsHeld(steps, OKAFOR),
      resolve,
      owner: PRIYA,
    },
    depsFor(steps.length)
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

  // Jordan claims the registrar task and sends it back with a note: the one
  // outcome his grant allows (AC-4, WF-3).
  const jordanClaim = claim(instanceAfter(steps), JORDAN, 3, depsFor(steps.length))
  if (jordanClaim.operation === undefined) throw new Error(jordanClaim.reason)
  steps.push(declared(jordanClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))
  const sentBack = sendBack(
    instanceAfter(steps),
    JORDAN,
    REQUEST_STEP,
    COMMENT,
    4,
    { flow: SLUG, definition: definitionV1, grants: grantsHeld(steps, JORDAN), resolve },
    depsFor(steps.length)
  )
  if (sentBack.operation === undefined) throw new Error(sentBack.reason)
  steps.push(
    declared(sentBack.operation, {
      instanceId: INSTANCE_ID,
      to: REQUEST_STEP,
      comment: COMMENT,
      version: 4,
    })
  )

  // Dana revokes Ana's reject: the same attributed change, in the other
  // direction (AC-2, I14).
  steps.push(
    declared(revokeGrant(revoked, DANA, depsFor(steps.length)), {
      principal: revoked.principal,
      scopes: revoked.scopes,
      resource: revoked.resource,
      change: 'revoked',
    })
  )
  return steps
}

export const golden = scenario({
  slug: 'grant-scopes',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup and the grants. */
export const STEP = {
  firstGrant: 6,
  start: 13,
  submit: 14,
  okaforClaim: 15,
  okaforApprove: 16,
  jordanClaim: 17,
  jordanSendBack: 18,
  revoke: 19,
} as const

/**
 * What each step requires of its actor (I8), for the Actor operator: only
 * Dana may grant and revoke (org.grants on org), Sam may start through his
 * group, the holder with the outcome scope decides a step (AS-2, AC-4).
 */
export const requires: Requirements = (step, index) => {
  switch (step.type) {
    case DEFINITION_CHANGED:
    case DEFINITION_PUBLISHED:
      return { scope: 'flow.build', resource: FLOW }
    case TEAM_CHANGE_TYPE:
      return { scope: 'org.teams', resource: 'org' }
    case GRANT_CHANGE_TYPE:
      return { scope: 'org.grants', resource: 'org' }
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
    case STEP_SENT_BACK:
      return {
        scope: 'step.outcome:send_back',
        resource: stepResource(REGISTRAR_STEP),
        actors: [JORDAN],
      }
    default:
      throw new Error(`S02: step ${index + 1} has no requirement (${step.type})`)
  }
}
