import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { addGrant, GRANT_CHANGE_TYPE } from '../../engine/grants.js'
import { instanceOf, type ProjectedInstance } from '../../engine/instances.js'
import type { OperationDeps } from '../../engine/operation.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import {
  cancel,
  INSTANCE_CANCELLED,
  INSTANCE_UNDONE,
  INSTANCE_WITHDRAWN,
  undoWithdrawOrCancel,
  withdraw,
} from '../../engine/withdraw.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, type StepClock, scenario, stepOperation } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  DANA,
  declared,
  definitionV1,
  directory,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  JORDAN,
  LEE,
  membership,
  OKAFOR,
  PRIYA,
  SAM,
  SLUG,
  samValues,
  setupSteps,
  stepResource,
} from '../example-flow.js'

// S13: withdraw or cancel a submission (STORIES.md). Sam's request reaches
// the registrar step, held by Ana. Sam withdraws his own instance (WF-4,
// AC-5): the open task closes and Ana is notified in the same commit (SE-5,
// I2). He undoes the withdrawal within the undo period of the flow, which
// restores the registrar step and its holder as a compensating event (WF-5,
// I4). Priya, who holds `instance.cancel` through a grant that Dana records
// (AC-1, S02), cancels the request that is not valid, and undoes that too.
// Every step after the setup is a client intent that the server resolves
// (ADR 0010). The undo period is measured on the clock, so the story places
// its steps one hour apart (I6): the undo follows the close within the
// twenty-four hours that the flow allows by default (WF-5).

/** Sam's request: a two-credit overload, so the chair step is skipped (S05). */
export const values = samValues(2)

/** The reason that Sam gives for the withdrawal (S13, WF-4). */
export const WITHDRAW_REASON = 'Dropped a class'

/** The reason that Priya gives for the cancellation (S13, AC-5, MVP.md 5.6). */
export const CANCEL_REASON = 'Duplicate of #4411'

/** One hour in milliseconds: the distance between two steps of the story. */
export const HOUR = 3_600_000

/** The time of the first step (I6): the clock is injected and the path reads no random source. */
export const T0 = 1_700_000_000_000

/** The step clock of the story (I6): one step an hour, so an undo follows its close within the period (WF-5). */
export const clock: StepClock = (index) => T0 + index * HOUR

/** The injected sources of step `index` under the story clock (I6). */
function depsAt(index: number): OperationDeps {
  return { clock: () => clock(index), ids: () => `op-${index + 1}` }
}

/** The state after the steps, replayed under the story clock (I6): a close stamps its time from it. */
export function stateAfter(steps: readonly Step[]): State {
  let state = emptyState
  steps.forEach((step, index) => {
    state = apply(stepOperation(step, index, clock), state)
  })
  return state
}

/** The instance as the log projects it after the steps, under the story clock (I4). */
export function instanceAfter(steps: readonly Step[]): ProjectedInstance {
  const instance = instanceOf(stateAfter(steps).log, INSTANCE_ID)
  if (instance === undefined) throw new Error(`the steps hold no instance ${INSTANCE_ID}`)
  return instance
}

/** The undo period of the flow (WF-5): the server default of twenty-four hours. */
export const UNDO_PERIOD = 24 * HOUR

/** Priya's cancel grant (AC-5, AC-1): Dana records it on the log, so the engine authorizes her cancel. */
export const cancelGrant = { principal: PRIYA, scopes: ['instance.cancel'], resource: FLOW }

/** The golden path: the setup and Priya's grant, then the request, its withdrawal, the undo, the cancel and its undo. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Dana grants Priya instance.cancel on the flow (S02, AC-2, I14).
  steps.push(declared(addGrant(cancelGrant, DANA, depsAt(6)), cancelGrant))

  // Sam starts and submits; Dr. Okafor approves; the chair step is skipped
  // and the registrar team gets the task; Ana claims it (S06, S09).
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsAt(7), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: SAM },
    depsAt(8)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsAt(9))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    depsAt(10)
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
  const anaClaim = claim(instanceAfter(steps), ANA, 3, depsAt(11))
  if (anaClaim.operation === undefined) throw new Error(anaClaim.reason)
  steps.push(declared(anaClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))

  // Sam withdraws his own request (WF-4, AC-5): the registrar task closes and
  // Ana, its holder, is notified in the same commit (SE-5, I2).
  const withdrawn = withdraw(instanceAfter(steps), SAM, WITHDRAW_REASON, depsAt(12))
  if (withdrawn.operation === undefined) throw new Error(withdrawn.reason)
  steps.push(
    declared(withdrawn.operation, { instanceId: INSTANCE_ID, reason: WITHDRAW_REASON, version: 4 })
  )

  // One hour later Sam undoes the withdrawal (WF-5, I4): the compensating
  // event restores the registrar step and its holder.
  const restored = undoWithdrawOrCancel(
    instanceAfter(steps),
    SAM,
    5,
    UNDO_PERIOD,
    clock(13),
    depsAt(13)
  )
  if (restored.operation === undefined) throw new Error(restored.reason)
  steps.push(declared(restored.operation, { instanceId: INSTANCE_ID, version: 5 }))

  // Priya cancels the request that is not valid (WF-4, AC-5, AC-1), and
  // undoes the cancellation an hour later (WF-5).
  const cancelled = cancel(
    instanceAfter(steps),
    PRIYA,
    CANCEL_REASON,
    { flow: SLUG, grants: [...grantsOfPerson(PRIYA), cancelGrant] },
    depsAt(14)
  )
  if (cancelled.operation === undefined) throw new Error(cancelled.reason)
  steps.push(
    declared(cancelled.operation, { instanceId: INSTANCE_ID, reason: CANCEL_REASON, version: 6 })
  )
  const reopened = undoWithdrawOrCancel(
    instanceAfter(steps),
    PRIYA,
    7,
    UNDO_PERIOD,
    clock(15),
    depsAt(15)
  )
  if (reopened.operation === undefined) throw new Error(reopened.reason)
  steps.push(declared(reopened.operation, { instanceId: INSTANCE_ID, version: 7 }))
  return steps
}

export const golden = scenario({
  slug: 'withdraw-cancel',
  flowSlug: SLUG,
  bootstrap,
  membership,
  clock,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup, for the requirements and the tests. */
export const STEP = {
  grant: 6,
  start: 7,
  submit: 8,
  okaforClaim: 9,
  okaforApprove: 10,
  anaClaim: 11,
  withdraw: 12,
  undoWithdraw: 13,
  cancel: 14,
  undoCancel: 15,
} as const

/** The end state of the golden path, replayed from the declared events (I6). */
export function goldenState() {
  return stateAfter(golden.steps)
}

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * starter withdraws and undoes his withdrawal (AC-5, WF-5), instance.cancel
 * cancels, and the closer alone undoes a close (WF-5).
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
    case INSTANCE_WITHDRAWN:
      return { actors: [SAM] }
    case INSTANCE_CANCELLED:
      return { scope: 'instance.cancel', resource: FLOW }
    case INSTANCE_UNDONE:
      return { actors: index === STEP.undoWithdraw ? [SAM] : [PRIYA] }
    default:
      throw new Error(`S13: step ${index + 1} has no requirement (${step.type})`)
  }
}
