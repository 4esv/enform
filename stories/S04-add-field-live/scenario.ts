import { DEFINITION_CHANGED, type FlowDefinition, parse } from '../../engine/definition.js'
import {
  createFlow,
  DEFINITION_PUBLISHED,
  type FlowVersion,
  publish,
  push,
} from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import {
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { DRAFT_REBOUND, rebindDraft } from '../../engine/version.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import {
  ADVISOR_STEP,
  bootstrap,
  CHAIR_STEP,
  CHAIRS_GROUP,
  DANA,
  declared,
  definitionV1,
  depsFor,
  directory,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  membership,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  SAM,
  SLUG,
  samValues,
  setupSteps,
} from '../example-flow.js'

// S04: Dana adds a required field while submissions are in progress
// (STORIES.md). Sam has an open draft on version 1 and a submitted request on
// version 1 when Dana pushes and publishes version 2 (DF-2, DF-6). The
// submitted request stays on version 1. The draft moves to version 2 when Sam
// opens it again (RT-6, A7): on the release server the instance read rebinds
// it and appends `draft.rebound@1`; the harness has no read, so the story
// declares the rebind the engine computes as a step. The rebind keeps every
// value, names the new required field and the value that no longer fits,
// and deletes nothing. The path is deterministic (I6): it reads no clock and
// no random source.

/** The open draft and the submitted request (DF-2). */
export const DRAFT_ID = INSTANCE_ID
export const SUBMITTED_ID = 'inst-2'

/**
 * Version 2 (S04, DF-6): the request form gains the required field
 * reason_category, and the overload credits become a choice of one to four,
 * so the draft's number no longer fits (RT-6).
 */
export const definitionV2: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "select", "options": ["1", "2", "3", "4"], "required": true },
        { "key": "advisor", "control": "user", "required": true },
        { "key": "reason_category", "control": "text", "required": true }
      ],
      "editable": ["summary", "overload_credits", "advisor", "reason_category"]
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
    }
  ]
}
`)

/** The publication of version 2 (DF-2): the version the draft rebinds to. */
export const versionV2: FlowVersion = {
  version: 2,
  contentHash: contentHash(definitionV2),
  definition: definitionV2,
}

/** Sam's answers on both instances: a two-credit overload (S05). */
export const values = samValues(2)

/** The golden path: the setup, Sam's draft and his submitted request on v1, Dana's v2, the rebind of the draft. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)

  // Sam starts a draft he does not submit, and a second request that he
  // submits (ADR 0014); both start on version 1 (DF-2).
  const draft = startInstance(flow, DRAFT_ID, values, SAM, depsFor(6), resolve, sam)
  steps.push(declared(draft.operation, { flow: SLUG, instanceId: DRAFT_ID, values }))
  const other = startInstance(flow, SUBMITTED_ID, values, SAM, depsFor(7), resolve, sam)
  steps.push(declared(other.operation, { flow: SLUG, instanceId: SUBMITTED_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps, SUBMITTED_ID),
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: SAM },
    depsFor(8)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: SUBMITTED_ID, version: 0, values: {} }))

  // Dana pushes the structural change and publishes version 2 (DF-6, DF-2).
  const v1 = publish(push(createFlow(SLUG), definitionV1, depsFor(0), DANA).flow, depsFor(1), DANA)
  const pushed = push(v1.flow, definitionV2, depsFor(9), DANA, grantsOfPerson(DANA))
  steps.push(declared(pushed.operation))
  const published = publish(pushed.flow, depsFor(10), DANA, grantsOfPerson(DANA))
  steps.push(declared(published.operation))
  if (published.flow.versions[1].contentHash !== versionV2.contentHash) {
    throw new Error('S04: the published version 2 differs from the declared one')
  }

  // Sam opens his draft again: it rebinds to version 2, keeps its values and
  // reports what does not fit (RT-6, A7). The submitted request stays on
  // version 1 (DF-2).
  const rebound = rebindDraft(instanceAfter(steps, DRAFT_ID), SAM, versionV2, depsFor(11))
  if (rebound.operation === undefined) throw new Error(rebound.reason)
  steps.push(declared(rebound.operation))
  return steps
}

export const golden = scenario({
  slug: 'add-field-live',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup. */
export const STEP = {
  startDraft: 6,
  startOther: 7,
  submitOther: 8,
  pushV2: 9,
  publishV2: 10,
  rebind: 11,
} as const

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * build steps need `flow.build`, Sam starts through his group, only the
 * starter submits a draft, and only the starter's reopening rebinds it.
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
    case DRAFT_REBOUND:
      return { actors: [SAM] }
    default:
      throw new Error(`S04: step ${index + 1} has no requirement (${step.type})`)
  }
}
