import type { ConditionData } from '../../engine/condition.js'
import { DEFINITION_CHANGED, type JsonValue } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import {
  DRAFT_EDITED,
  editDraft,
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import type { Requirements } from '../../tools/harness/operators.js'
import { type Scenario, type Step, scenario } from '../../tools/harness/scenario.js'
import {
  bootstrap,
  declared,
  definitionV1,
  depsFor,
  directory,
  exampleFlowState,
  FLOW,
  flow,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  membership,
  OKAFOR,
  SAM,
  SLUG,
  setupSteps,
} from '../example-flow.js'

// S07: Sam loses the connection during fill-in (STORIES.md). He starts a
// draft, keeps typing while the connection is gone, refreshes, and submits;
// when the connection returns every edit arrives at the server once (I1,
// RT-3, RT-5). The engine path is a transport simulation: the golden path is
// the start, three draft edits and the submit, each a client intent that the
// server resolves (ADR 0010, ADR 0014), and the Offline operator does the
// steps without a connection, refreshes from the encrypted local store (RT-4,
// I11), reconnects and resends them twice (I1, I15, I16). The path is
// deterministic (I6): it reads no clock and no random source.

/** What Sam has typed when he starts the draft: the advisor and the credits, no summary yet (FM-7). */
export const startValues: ConditionData = { overload_credits: 2, advisor: OKAFOR }

/** The three edits Sam makes while offline, in order (RT-3, D1). */
export const edits: readonly Readonly<Record<string, JsonValue>>[] = [
  { summary: 'two extra' },
  { summary: 'two extra credits' },
  { overload_credits: 3 },
]

/** The values the draft holds after the edits, which the submit validates (FM-4). */
export const finalValues: ConditionData = {
  overload_credits: 3,
  advisor: OKAFOR,
  summary: 'two extra credits',
}

/**
 * The steps of the story (S07): the setup, the start, the edits and the
 * submit. `edits` is the list of edits to declare, so the test can build the
 * variant whose submit the server refuses.
 */
function goldenSteps(draftEdits: readonly Readonly<Record<string, JsonValue>>[]): readonly Step[] {
  const steps: Step[] = [...setupSteps()]
  const sam = grantsOfPerson(SAM)
  const started = startInstance(
    flow,
    INSTANCE_ID,
    startValues,
    SAM,
    depsFor(steps.length),
    directory(startValues),
    sam
  )
  steps.push(
    declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values: startValues })
  )
  for (const values of draftEdits) {
    const edited = editDraft(instanceAfter(steps), SAM, values, depsFor(steps.length))
    if (edited.operation === undefined) throw new Error(edited.reason)
    steps.push(declared(edited.operation, { instanceId: INSTANCE_ID, values }))
  }
  // The submit validates the values the draft holds (FM-4) and routes to the
  // advisor (WF-1); a draft edit never advances the version, so the submit
  // is based on version 0 (ADR 0014, I5).
  const draft = instanceAfter(steps)
  const resolve = directory(draft.values ?? {})
  const submitted = submitInstance(
    draft,
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve, grants: sam, owner: SAM },
    depsFor(steps.length)
  )
  if (submitted.operation === undefined) {
    // The variant whose submit the server refuses declares the refused
    // intent; the prediction decides the refusal (FM-4).
    steps.push({
      actor: SAM,
      type: INSTANCE_SUBMITTED,
      payload: { instanceId: INSTANCE_ID, version: 0, values: {} },
      intent: { instanceId: INSTANCE_ID, version: 0, values: {} },
    })
    return steps
  }
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))
  return steps
}

export const golden: Scenario = scenario({
  slug: 'lose-connection',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps(edits),
})

/**
 * The path whose submit the server refuses (S07, FM-4): Sam never typed the
 * summary, which the request form requires, so the submit that arrives when
 * the connection returns is refused with the field named, and the draft
 * stays complete on the device.
 */
export const incomplete: Scenario = scenario({
  slug: 'lose-connection',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: goldenSteps([{ overload_credits: 1 }, { overload_credits: 2 }, { overload_credits: 3 }]),
})

/** The indexes of the story's steps after the setup, for the requirements and the tests. */
export const STEP = { start: 6, firstEdit: 7, lastEdit: 9, submit: 10 } as const

/** What Sam typed first on the page: his advisor, with the other fields still empty (FM-7). */
const guiFirstChange: ConditionData = { summary: '', advisor: OKAFOR }

/** The edits the page posts, one per changed field (RT-3): two of them typed offline, one after the refresh. */
export const guiEdits: readonly Readonly<Record<string, JsonValue>>[] = [
  { overload_credits: 2 },
  { summary: 'two extra' },
  { summary: 'two extra credits' },
]

/**
 * The interface path of S07 (STORIES.md, #262): the browser starts the draft
 * on the first change, loses the connection, keeps typing (each edit saved
 * on the device and shown as such), refreshes and finds every value, submits
 * ("Will submit when you are back online"), and the connection returns: the
 * queued edits and the submit reach the server once each, and the tracker
 * shows the advisor step waiting. The flow is seeded (exampleFlowState), so
 * the steps are the start, the edits and the submit.
 */
function guiSteps(): readonly Step[] {
  const steps: Step[] = []
  const sam = grantsOfPerson(SAM)
  const started = startInstance(
    flow,
    INSTANCE_ID,
    guiFirstChange,
    SAM,
    depsFor(0),
    directory(guiFirstChange),
    sam
  )
  steps.push(
    declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values: guiFirstChange })
  )
  let instance = started.instance
  for (const values of guiEdits) {
    const edited = editDraft(instance, SAM, values, depsFor(steps.length))
    if (edited.operation === undefined) throw new Error(edited.reason)
    instance = edited.instance
    steps.push(declared(edited.operation, { instanceId: INSTANCE_ID, values }))
  }
  const merged = { ...guiFirstChange, ...Object.assign({}, ...guiEdits) }
  const submitted = submitInstance(
    instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition: definitionV1, resolve: directory(merged), grants: sam, owner: SAM },
    depsFor(steps.length)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  steps.push(declared(submitted.operation, { instanceId: INSTANCE_ID, version: 0, values: {} }))
  return steps
}

/** The seed of the browser path: version 1 published. */
export const guiSeed = exampleFlowState

export const guiGolden: Scenario = scenario({
  slug: 'lose-connection',
  flowSlug: SLUG,
  bootstrap,
  membership,
  steps: guiSteps(),
  gui: [
    {
      steps: 5,
      actions: [
        { fill: { field: 'advisor', value: OKAFOR } },
        { expectText: { selector: '[data-sync-for="advisor"]', text: 'Synced' } },
        // The connection drops: the next edits stay on the device (RT-3, I15).
        { offline: true },
        { expectText: { selector: '[data-connection]', text: 'Offline' } },
        { fill: { field: 'overload_credits', value: 2 } },
        {
          expectText: {
            selector: '[data-sync-for="overload_credits"]',
            text: 'Saved on this device',
          },
        },
        { fill: { field: 'summary', value: 'two extra' } },
        { expectText: { selector: '[data-sync-for="summary"]', text: 'Saved on this device' } },
        // A refresh while offline shows the device's copy at once (RT-4).
        { reload: true },
        { expectValue: { field: 'summary', value: 'two extra' } },
        { expectValue: { field: 'overload_credits', value: '2' } },
        { fill: { field: 'summary', value: 'two extra credits' } },
        { expectText: { selector: '[data-sync-for="summary"]', text: 'Saved on this device' } },
        // The submit waits for the connection (RT-5).
        { click: '[data-submit]' },
        { expect: 'Will submit when you are back online' },
        // The connection returns: the queue flushes, each edit once (I1), and
        // the submit routes the request to the advisor.
        { offline: false },
        { expectSelector: '[data-tracker-step="advisor"][data-tracker-state="unopened"]' },
      ],
    },
  ],
})

/**
 * What each step requires of its actor (I8), for the Actor operator: the
 * build scope for the flow, org.teams for the team, instance.start for the
 * start (AC-1), and the starter for a draft edit and the submit (ADR 0014).
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
    case DRAFT_EDITED:
    case INSTANCE_SUBMITTED:
      return { actors: [SAM] }
    default:
      throw new Error(`S07: step ${index + 1} has no requirement (${step.type})`)
  }
}
