import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import type { ConditionData } from '../../engine/condition.js'
import { DEFINITION_CHANGED, type FlowStep, type JsonValue } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
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
  bootstrap,
  CHAIR_STEP,
  declared,
  definitionV1,
  depsFor,
  directory,
  FLOW,
  flow,
  grantsOfPerson,
  instanceAfter,
  LIN,
  membership,
  OKAFOR,
  SAM,
  SLUG,
  samValues,
  setupSteps,
  stepResource,
} from '../example-flow.js'

// S05: Dana skips the chair step for a small overload (STORIES.md). The chair
// step of the example flow carries a skip condition, a JSON Logic expression
// (FM-5, WF-1): when the request has at most two overload credits, the chair
// is skipped and the completion that routes past it records the skip with
// its condition, so the timeline and the tracker show the reason (VT-2). Two
// requests drive the condition: Sam's two-credit request goes from the
// advisor straight to the registrar, and his four-credit request stops at the
// chair, where Dr. Lin claims it through the CS-Chairs group (AS-4). Every
// step after the setup is a client intent that the server resolves (ADR
// 0010). The path is deterministic (I6): it reads no clock and no random
// source, and the directory is injected.

/** The chair step, the one conditional step of the story (S05). */
export const chairStep: FlowStep = definitionV1.steps[2]

/** The skip condition of the chair step (S05, FM-5): the overload credit limit. */
export const chairSkipWhen: JsonValue = { '<=': [{ var: 'overload_credits' }, 2] }

/** The two requests: two credits skip the chair, four credits reach it (S05). */
export const SMALL_ID = 'inst-small'
export const LARGE_ID = 'inst-large'
export const smallOverload: ConditionData = samValues(2)
export const largeOverload: ConditionData = samValues(4)

/** The golden path: the setup, the two-credit request to the registrar, the four-credit request to the chair. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const sam = grantsOfPerson(SAM)

  // One request from the start to the advisor's approval (S06, S09): the
  // start and the submit by Sam, then Dr. Okafor's claim and approval, which
  // routes past the chair or into it (WF-1).
  const request = (id: string, values: ConditionData): void => {
    const resolve = directory(values)
    const context = { flow: SLUG, definition: definitionV1, resolve, owner: SAM }
    const at = () => steps.length
    const started = startInstance(flow, id, values, SAM, depsFor(at()), resolve, sam)
    steps.push(declared(started.operation, { flow: SLUG, instanceId: id, values }))
    const submitted = submitInstance(
      instanceAfter(steps, id),
      SAM,
      {},
      0,
      { ...context, grants: sam },
      depsFor(at())
    )
    if (submitted.operation === undefined) throw new Error(submitted.reason)
    steps.push(declared(submitted.operation, { instanceId: id, version: 0, values: {} }))
    const claimed = claim(instanceAfter(steps, id), OKAFOR, 1, depsFor(at()))
    if (claimed.operation === undefined) throw new Error(claimed.reason)
    steps.push(declared(claimed.operation, { instanceId: id, expectedVersion: 1 }))
    const approved = complete(
      instanceAfter(steps, id),
      OKAFOR,
      'approve',
      {},
      2,
      { ...context, grants: grantsOfPerson(OKAFOR) },
      depsFor(at())
    )
    if (approved.operation === undefined) throw new Error(approved.reason)
    steps.push(
      declared(approved.operation, { instanceId: id, version: 2, outcome: 'approve', values: {} })
    )
  }

  // (a) Two credits: the advisor's approval skips the chair and routes to the
  // registrar, recording the skip and its condition (WF-1, VT-2).
  request(SMALL_ID, smallOverload)
  // (b) Four credits: the chair is active, and Dr. Lin claims it through the
  // CS-Chairs group (AS-4).
  request(LARGE_ID, largeOverload)
  const lin = claim(instanceAfter(steps, LARGE_ID), LIN, 3, depsFor(steps.length))
  if (lin.operation === undefined) throw new Error(lin.reason)
  steps.push(declared(lin.operation, { instanceId: LARGE_ID, expectedVersion: 3 }))
  return steps
}

export const golden = scenario({
  slug: 'skip-step',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup, for the requirements and the tests. */
export const STEP = {
  smallStart: 6,
  smallSubmit: 7,
  smallClaim: 8,
  smallApprove: 9,
  largeStart: 10,
  largeSubmit: 11,
  largeClaim: 12,
  largeApprove: 13,
  linClaim: 14,
} as const

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * build scope for the flow, org.teams for the team, instance.start for a
 * start, the starter for a submit, the assignee for a claim (Dr. Okafor on
 * the advisor step, Dr. Lin on the chair step), and the holder with the
 * outcome scope for an approval (AS-2, AC-4).
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
      return { actors: index === STEP.linClaim ? [LIN] : [OKAFOR] }
    case STEP_COMPLETED:
      return {
        scope: 'step.outcome:approve',
        resource: stepResource(ADVISOR_STEP),
        actors: [OKAFOR],
      }
    default:
      throw new Error(`S05: step ${index + 1} has no requirement (${step.type})`)
  }
}

/** The chair step key, for the tests. */
export const CHAIR = CHAIR_STEP
