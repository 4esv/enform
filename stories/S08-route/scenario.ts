import { claim, complete, STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import type { ConditionData } from '../../engine/condition.js'
import {
  DEFINITION_CHANGED,
  type Field,
  type FlowDefinition,
  parse,
} from '../../engine/definition.js'
import { createFlow, DEFINITION_PUBLISHED, type Flow, publish, push } from '../../engine/flow.js'
import { addGrant, GRANT_CHANGE_TYPE } from '../../engine/grants.js'
import { contentHash } from '../../engine/instance.js'
import type { ActorId } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { resolverFor } from '../../server/intents.js'
import type { Requirements, Versioning } from '../../tools/harness/operators.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  ANA,
  bootstrap,
  CHAIRS_GROUP,
  DANA,
  declared,
  depsFor,
  FLOW,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  LIN,
  membership,
  OKAFOR,
  PRIYA,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  SAM,
  SLUG,
  STUDENTS_GROUP,
  samValues,
  stepResource,
} from '../example-flow.js'

// S08: route each task to real, current people (STORIES.md). The advisor step
// names its recipient through the form field `advisor`, resolved once at the
// submit with a snapshot (AS-1, I13). The registrar step names the
// registrar-office team, which resolves live (AS-4): Ana joins the team by a
// team change while the registrar task is open, and a read shows the task to
// her with no new publication. The archive step names a team that holds
// nobody, so when Lee's approval enters it the task goes to the Unroutable
// queue and Priya, the flow owner, gets the alert with the reason (I10,
// AS-5). Every step after the setup is a client intent that the server
// resolves (ADR 0010). The path is deterministic (I6): it reads no clock and
// no random source, and the directory is injected.

/** The archive team, which nobody has joined when the request reaches it (AS-5). */
export const ARCHIVE_TEAM = 'archive-office'
export const ARCHIVE_STEP = 'archive'

/** The members of registrar-office when Sam submits: Lee and Jordan. Ana joins later (AS-4). */
export const INITIAL_REGISTRARS: readonly ActorId[] = [LEE, JORDAN]

/**
 * The flow of the story: the request form, the advisor by field, the
 * registrar team, and an archive step whose team is empty (AS-1, AS-5).
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
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["approve", "reject"]
    },
    {
      "key": "${ARCHIVE_STEP}",
      "targets": [{ "team": "${ARCHIVE_TEAM}" }],
      "outcomes": ["record"]
    }
  ]
}
`)

/** Version 2 of the flow: it adds an optional field to the request form (DF-2), for the Version operator. */
export const definitionV2: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number", "required": true },
        { "key": "advisor", "control": "user", "required": true },
        { "key": "reason_category", "control": "text" }
      ],
      "editable": ["summary", "overload_credits", "advisor", "reason_category"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["approve", "reject"]
    },
    {
      "key": "${ARCHIVE_STEP}",
      "targets": [{ "team": "${ARCHIVE_TEAM}" }],
      "outcomes": ["record"]
    }
  ]
}
`)

/** The flow ready for a start: version 1 published (DF-2). */
export const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

/** The form fields of the flow (FM-1): the Data operator generates values for them. */
export const fields: readonly Field[] = definition.steps.flatMap((step) => step.fields ?? [])

/** How the Version operator publishes version 2 between two steps (STORIES.md, Fuzzy paths). */
export const versioning: Versioning = {
  actor: DANA,
  slug: SLUG,
  definition: definitionV2,
  started: definition,
}

/** Sam's request: a two-credit overload with Dr. Okafor as his advisor (FM-7). */
export const values: ConditionData = samValues(2)

/**
 * The directory of the story at a point in time (AS-1, AS-4): the release
 * server's resolver over the teams the log holds and the groups of the
 * cast. The registrar team holds `registrars`; the archive team holds nobody.
 */
export function directoryWith(registrars: readonly ActorId[]): TargetResolver {
  return resolverFor(
    SAM,
    values,
    new Map([
      [REGISTRAR_TEAM, registrars],
      [ARCHIVE_TEAM, []],
    ]),
    new Map([
      [CHAIRS_GROUP, [LIN]],
      [STUDENTS_GROUP, [SAM]],
    ])
  )
}

/** The golden path: the setup, the request to the registrar, Ana's join, and the approval that is unroutable. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = []
  const at = () => steps.length
  const team = (change: Record<string, unknown>): Step => ({
    actor: DANA,
    type: TEAM_CHANGE_TYPE,
    payload: change,
    intent: change,
  })

  // The setup (S01, AS-6): Dana publishes the flow, creates the registrar
  // team with Lee and Jordan, and the archive team with nobody.
  const pushed = push(createFlow(SLUG), definition, depsFor(0), DANA)
  const published = publish(pushed.flow, depsFor(1), DANA)
  steps.push(declared(pushed.operation), declared(published.operation))
  steps.push(team({ team: REGISTRAR_TEAM, change: 'created' }))
  for (const member of INITIAL_REGISTRARS) {
    steps.push(team({ team: REGISTRAR_TEAM, change: 'member-added', member }))
  }
  steps.push(team({ team: ARCHIVE_TEAM, change: 'created' }))

  // Priya owns the flow (STORIES.md, Cast): Dana records her task.reassign
  // on the log, so the Unroutable alert reaches her (I10, AS-5).
  const owner = { principal: PRIYA, scopes: ['task.reassign'], resource: FLOW }
  steps.push(declared(addGrant(owner, DANA, depsFor(at())), owner))

  // Sam starts and submits: the advisor field resolves to Dr. Okafor, a
  // snapshot (AS-1, I13).
  const resolve = directoryWith(INITIAL_REGISTRARS)
  const sam = grantsOfPerson(SAM)
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(at()), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: sam, owner: PRIYA },
    depsFor(at())
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))

  // Dr. Okafor approves: the registrar step resolves to the team's current
  // members, Lee and Jordan (AS-4).
  const okaforClaim = claim(instanceAfter(steps), OKAFOR, 1, depsFor(at()))
  if (okaforClaim.operation === undefined) throw new Error(okaforClaim.reason)
  steps.push(declared(okaforClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 1 }))
  const okaforApprove = complete(
    instanceAfter(steps),
    OKAFOR,
    'approve',
    {},
    2,
    { flow: SLUG, definition, grants: grantsOfPerson(OKAFOR), resolve, owner: PRIYA },
    depsFor(at())
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

  // Ana joins registrar-office while the task is open (AS-4): no publication.
  steps.push(team({ team: REGISTRAR_TEAM, change: 'member-added', member: ANA }))

  // Lee approves: the archive team holds nobody, so the task goes to the
  // Unroutable queue and Priya gets the alert (I10, AS-5).
  const leeClaim = claim(instanceAfter(steps), LEE, 3, depsFor(at()))
  if (leeClaim.operation === undefined) throw new Error(leeClaim.reason)
  steps.push(declared(leeClaim.operation, { instanceId: INSTANCE_ID, expectedVersion: 3 }))
  const leeApprove = complete(
    instanceAfter(steps),
    LEE,
    'approve',
    {},
    4,
    {
      flow: SLUG,
      definition,
      grants: grantsOfPerson(LEE),
      resolve: directoryWith([...INITIAL_REGISTRARS, ANA]),
      owner: PRIYA,
    },
    depsFor(at())
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
  slug: 'route',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps, for the requirements and the tests. */
export const STEP = {
  ownerGrant: 6,
  start: 7,
  submit: 8,
  okaforClaim: 9,
  okaforApprove: 10,
  anaJoins: 11,
  leeClaim: 12,
  leeApprove: 13,
} as const

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * build scope for the flow, org.teams for a team change, org.grants for the
 * owner grant, instance.start for the start, the starter for the submit, the
 * assignee for a claim, and the holder with the outcome scope for an
 * approval (AS-2, AC-4).
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
      // The registrar claim is open to the team's current members (AS-4,
      // #267): Lee and Jordan, and Ana once she joined at the step before.
      return { actors: index === STEP.okaforClaim ? [OKAFOR] : [...INITIAL_REGISTRARS, ANA] }
    case STEP_COMPLETED:
      return index === STEP.okaforApprove
        ? { scope: 'step.outcome:approve', resource: stepResource(ADVISOR_STEP), actors: [OKAFOR] }
        : { scope: 'step.outcome:approve', resource: stepResource(REGISTRAR_STEP), actors: [LEE] }
    default:
      throw new Error(`S08: step ${index + 1} has no requirement (${step.type})`)
  }
}
