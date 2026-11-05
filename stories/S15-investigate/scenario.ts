import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import type { State } from '../../engine/apply.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { createFlow, DEFINITION_PUBLISHED, publish, push } from '../../engine/flow.js'
import { addGrant, GRANT_CHANGE_TYPE } from '../../engine/grants.js'
import { instanceOf, type ProjectedInstance } from '../../engine/instances.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { resolverFor } from '../../server/intents.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  CHAIRS_GROUP,
  DANA,
  declared,
  definitionV1,
  definitionV2,
  depsFor,
  directory,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  LIN,
  membership,
  OKAFOR,
  PRIYA,
  REGISTRAR_TEAM,
  SAM,
  SLUG,
  samValues,
  setupSteps,
  stateAfter,
  stepResource,
} from '../example-flow.js'

// S15: investigate a problem (STORIES.md). Sam's request is in progress when
// Dana publishes version 2 of the flow, grants Lee a read on it and removes
// Jordan from the registrar team; Dr. Okafor then approves, so the registrar
// task resolves to the team as the log holds it now (AS-4, I13). The
// instance timeline with changes shows the instance events and the
// configuration changes in one global order, each change with its author
// (VT-5, VT-6, I4, I14), and the instance in progress stays on version 1
// (DF-2). Every step after the setup is a client intent that the server
// resolves (ADR 0010), except the push and the publication, which the server
// appends as the resolved configuration changes they are. The path is
// deterministic (I6).

/** Sam's request: a two-credit overload, so the chair step is skipped (S05). */
export const values = samValues(2)

/** The grant that Dana records during the investigation: Lee reads the flow's instances (S02, AC-2). */
export const leeRead = { principal: LEE, scopes: ['instance.read'], resource: FLOW }

/** The team change that Dana records: Jordan leaves the registrar office (AS-6). */
export const jordanLeaves = { team: REGISTRAR_TEAM, change: 'member-removed', member: JORDAN }

/** The golden path: the setup, Sam's request, Dana's three changes, then Dr. Okafor's approval. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const sam = grantsOfPerson(SAM)

  // Sam starts and submits (S06, ADR 0014): the request reaches Dr. Okafor.
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(6), directory(values), sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve: directory(values), grants: sam, owner: SAM },
    depsFor(7)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dana pushes and publishes version 2 (DF-2, DF-4), grants Lee a read
  // (AC-2) and removes Jordan from the registrar team (AS-6): four attributed
  // configuration changes on the one log (I14).
  const pushedV1 = push(createFlow(SLUG), definitionV1, depsFor(0), DANA)
  const publishedV1 = publish(pushedV1.flow, depsFor(1), DANA)
  const pushedV2 = push(publishedV1.flow, definitionV2, depsFor(8), DANA)
  const publishedV2 = publish(pushedV2.flow, depsFor(9), DANA)
  steps.push(declared(pushedV2.operation), declared(publishedV2.operation))
  steps.push(declared(addGrant(leeRead, DANA, depsFor(10)), leeRead))
  steps.push({ actor: DANA, type: TEAM_CHANGE_TYPE, payload: jordanLeaves, intent: jordanLeaves })

  // Dr. Okafor claims and approves: the chair step is skipped, and the
  // registrar task resolves to the team as the log holds it now, Lee and Ana
  // (AS-4, I13). The instance stays on version 1 (DF-2).
  const resolve = resolverFor(
    SAM,
    values,
    new Map([[REGISTRAR_TEAM, [LEE, ANA]]]),
    new Map([[CHAIRS_GROUP, [LIN]]])
  )
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsFor(12))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    depsFor(13)
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
  return steps
}

export const golden = scenario({
  slug: 'investigate',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup, for the requirements and the tests. */
export const STEP = {
  start: 6,
  submit: 7,
  pushV2: 8,
  publishV2: 9,
  grantLee: 10,
  removeJordan: 11,
  okaforClaim: 12,
  okaforApprove: 13,
} as const

/** What each step requires of its actor (I8), for the Actor operator. */
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
      return { actors: [OKAFOR] }
    case STEP_COMPLETED:
      return {
        scope: 'step.outcome:approve',
        resource: stepResource(ADVISOR_STEP),
        actors: [OKAFOR],
      }
    default:
      throw new Error(`S15: step ${index + 1} has no requirement (${step.type})`)
  }
}

/**
 * The server state the interface path starts from (#269, S15): the request
 * submitted and Dana's four changes recorded. The seed's operation ids are
 * prefixed, so the browser's `op-1` is a new operation and not a retry of
 * the seed's first one (I1).
 */
export function guiSeed(): State {
  const state = stateAfter(golden.steps.slice(0, STEP.okaforClaim))
  const log = state.log.map((event) => ({ ...event, operationId: `seed-${event.operationId}` }))
  return { applied: new Set(log.map((event) => event.operationId)), log }
}

/**
 * The interface path of S15 (STORIES.md): Priya opens the instance timeline,
 * toggles the flow's changes in and reads them between the instance events
 * in one order, each with its author and the definition change with a link
 * to its difference (VT-5, I4, I14); then Dr. Okafor claims and approves.
 */
function guiSteps(seed: State): readonly Step[] {
  const steps: Step[] = []
  const instanceAt = (): ProjectedInstance => {
    const log = [...seed.log, ...stateAfter(steps).log].map((event, index) => ({
      ...event,
      seq: index + 1,
    }))
    const instance = instanceOf(log, INSTANCE_ID)
    if (instance === undefined) throw new Error('S15 gui: no instance')
    return instance
  }
  const resolve = resolverFor(
    SAM,
    values,
    new Map([[REGISTRAR_TEAM, [LEE, ANA]]]),
    new Map([[CHAIRS_GROUP, [LIN]]])
  )
  const okaforClaim = claim(instanceAt(), OKAFOR, 1, depsFor(0))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAt(),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition: definitionV1, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    depsFor(1)
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
  return steps
}

export const guiGolden = scenario({
  slug: 'investigate',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: guiSteps(guiSeed()),
  gui: [
    {
      // Priya, who follows the flow, toggles its changes into the timeline: the publication,
      // the grant and the team change show in log order with their author,
      // and the definition change links to its difference (VT-5, DF-6).
      instance: INSTANCE_ID,
      actor: PRIYA,
      steps: 0,
      actions: [
        { click: '[data-timeline-changes]' },
        { expectSelector: '[data-timeline-type="config.definition.published@1"]' },
        { expectSelector: '[data-timeline-type="config.grant.changed@1"]' },
        { expectSelector: '[data-timeline-type="config.team.changed@1"]' },
        {
          expectSelector:
            '[data-timeline-type="config.definition.published@1"] [data-timeline-diff]',
        },
        {
          expectOrder: [
            '[data-timeline-type="instance.submitted@1"]',
            '[data-timeline-type="config.definition.published@1"]',
            '[data-timeline-type="config.grant.changed@1"]',
            '[data-timeline-type="config.team.changed@1"]',
          ],
        },
      ],
    },
    { instance: INSTANCE_ID, actions: [{ click: '[data-claim]' }, { expect: 'Claimed' }] },
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
