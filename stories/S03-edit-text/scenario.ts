import type { Grant } from '../../engine/authorize.js'
import { DEFINITION_CHANGED, type FlowDefinition, parse } from '../../engine/definition.js'
import { createFlow, DEFINITION_PUBLISHED, type Flow, publish, push } from '../../engine/flow.js'
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
  CHAIRS_GROUP,
  DANA,
  declared,
  definitionV1,
  depsFor,
  directory,
  FLOW,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  membership,
  PRIYA,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  REQUEST_STEP,
  SAM,
  SLUG,
  samValues,
  setupSteps,
} from '../example-flow.js'

// S03: Priya edits the text of a form (STORIES.md). A definition change is
// edit-class or structural, and the class picks the scope (DF-5, D2): an
// edit-class change needs `flow.edit`, a structural change needs
// `flow.build`. Priya holds `flow.edit` and not `flow.build` (STORIES.md,
// Cast), so her push of a label and a new option succeeds and the log
// attributes it to her, and she publishes it as version 2 (DF-3, I14). A push
// that adds a field is structural, so the engine refuses it and names the
// change and the scope; the scenario test proves that refusal through the
// engine. A new instance starts on her version (DF-2). The pushes and the
// publications are resolved configuration operations the server appends as
// they stand (I14); the start and the submit are client intents (ADR 0010).
// The path is deterministic (I6): it reads no clock and no random source.

/** Priya's edit-class change (S03, DF-5): the summary gains a label, the advisor gains the option "escalate". */
export const edited: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "label": "Summary of your request", "required": true },
        { "key": "overload_credits", "control": "number", "required": true },
        { "key": "advisor", "control": "user", "required": true }
      ],
      "editable": ["summary", "overload_credits", "advisor"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back", "escalate"]
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

/** Priya's structural change (S03, DF-5): a new field on the request form, which the engine refuses her. */
export const withField: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number", "required": true },
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

/** Priya's grants (STORIES.md, Cast): `flow.edit` on the flow and no `flow.build`. */
export const priyaGrants: readonly Grant[] = grantsOfPerson(PRIYA)

/** The flow once Dana published version 1 (DF-2): the draft that Priya edits. */
export function flowV1(): Flow {
  const pushed = push(createFlow(SLUG), definitionV1, depsFor(0), DANA)
  return publish(pushed.flow, depsFor(1), DANA).flow
}

/** Sam's request: a two-credit overload (S05). */
export const values = samValues(2)

/** The golden path: the setup, Priya's edit and its publication, then Sam's request on version 2. */
function goldenSteps(): readonly Step[] {
  const steps: Step[] = [...setupSteps()]

  // Priya pushes her edit-class change and publishes it: the engine
  // authorizes both against her `flow.edit` (DF-5, D2, I14).
  const pushed = push(flowV1(), edited, depsFor(6), PRIYA, priyaGrants)
  steps.push(declared(pushed.operation))
  const published = publish(pushed.flow, depsFor(7), PRIYA, priyaGrants)
  steps.push(declared(published.operation))

  // Sam starts and submits on version 2 (DF-2): the start pins the instance to
  // the newest version, and the submit routes it to Dr. Okafor (ADR 0014).
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)
  const started = startInstance(published.flow, INSTANCE_ID, values, SAM, depsFor(8), resolve, sam)
  steps.push(declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values }))
  const submitted = submitInstance(
    instanceAfter(steps),
    SAM,
    {},
    0,
    { flow: SLUG, definition: edited, resolve, grants: sam, owner: SAM },
    depsFor(9)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))
  return steps
}

export const golden = scenario({
  slug: 'edit-text',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(),
})

/** The indexes of the story's steps after the setup. */
export const STEP = { priyaPush: 6, priyaPublish: 7, start: 8, submit: 9 } as const

/**
 * What each step requires of its actor (I8), for the Actor operator: Dana's
 * build steps need `flow.build`; Priya's edit-class push and publication
 * need `flow.edit`, which `flow.build` also covers (D2), so Dana and Priya
 * reach them and nobody else; Sam starts and submits.
 */
export const requires: Requirements = (step, index) => {
  switch (step.type) {
    case DEFINITION_CHANGED:
    case DEFINITION_PUBLISHED:
      return index >= STEP.priyaPush
        ? { actors: [DANA, PRIYA] }
        : { scope: 'flow.build', resource: FLOW }
    case TEAM_CHANGE_TYPE:
      return { scope: 'org.teams', resource: 'org' }
    case INSTANCE_STARTED:
      return { scope: 'instance.start', resource: FLOW }
    case INSTANCE_SUBMITTED:
      return { actors: [SAM] }
    default:
      throw new Error(`S03: step ${index + 1} has no requirement (${step.type})`)
  }
}
