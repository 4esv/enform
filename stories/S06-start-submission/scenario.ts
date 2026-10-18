import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import { createFlow, type Flow, type FlowVersion, publish, push } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import type { TargetResolver } from '../../engine/routing.js'
import { startInstance, submitInstance } from '../../engine/submission.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'

// S06: Sam starts and submits a submission (STORIES.md). He opens the form
// link, fills it in and submits it. The engine never creates an anonymous
// draft (ID-2): the start needs a signed-in principal, here Sam, and the scope
// instance.start on the flow (AC-1). The start routes the draft to the first
// step whose skip condition is false (WF-1, I10): the fixture data is not
// urgent, so the triage step is skipped and the draft routes to the advisor
// step, whose user target resolves to Dr. Okafor. The submit records the
// assignment email that he receives (I2, SE-1). The path is deterministic
// (I6): it reads no clock and no random source.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/**
 * The instance id that Sam's start mints (DX-1, #187): deterministic, like
 * every injected source (I6). The fixture and the browser cannot drift,
 * because gui mode reads this id back from the start step's payload.
 */
export const INSTANCE_ID = 'inst-1'

/** The definition of version 1, the version that a start pins the instance to (DF-1, DF-2). */
export const definitionV1: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "triage",
      "targets": [{ "group": "CS-Chairs" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number" },
        { "key": "urgent", "control": "checkbox" },
        { "key": "details", "control": "long-text" }
      ],
      "editable": ["summary", "overload_credits", "urgent", "details"],
      "skipWhen": { "==": [{ "var": "urgent" }, false] }
    },
    {
      "key": "advisor",
      "targets": [{ "user": "user:okafor" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "registrar",
      "targets": [{ "user": "user:lee" }],
      "outcomes": ["record"]
    }
  ]
}
`)

/** The published version 1: the start needs a version with a content hash (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definitionV1),
  definition: definitionV1,
}

/** The flow of the story: version 1 published, ready for a start (DF-2). */
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/**
 * The server state that gui mode starts from (DF-2): version 1 published in
 * the log, so the app can read it back and the engine can resolve the start
 * intent against it. The grants and the directory arrive as injected sources.
 */
export function flowState(): State {
  const deps = (id: string): OperationDeps => ({ clock: () => 0, ids: () => id })
  const pushed = push(createFlow(SLUG), definitionV1, deps('flow-push'), 'user:dana')
  const published = publish(pushed.flow, deps('flow-publish'), 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/**
 * The data of Sam's request: it is not urgent, so the triage step is skipped
 * (WF-1). The other entries are the values of the form that Sam fills (FM-7).
 */
export const samData: ConditionData = {
  summary: 'three extra credits',
  overload_credits: 3,
  urgent: false,
  details: 'I need three extra credits to graduate on time.',
}

/** The grants that apply to Sam: the All-Students group may start the flow (S02, ID-4, AC-1). */
export const samGrants: readonly Grant[] = [
  { principal: 'group:All-Students', scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The directory of the story (ID-4, AS-4): a user target names its principal, and a group or team resolves to nobody. */
export const resolve: TargetResolver = (target) => ('user' in target ? [target.user] : [])

/** Sam, the signed-in principal who starts the submission (S06, ID-2). */
const SAM = 'user:sam'

/**
 * The runner's injected sources (I6): the clock is the step index and the IDs
 * are `op-N`, exactly as `stepOperation` builds them, so the operations that
 * the engine produces equal the scenario's steps.
 */
function depsFor(index: number): OperationDeps {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

/**
 * The state-change payload without the outbox key. The runner wraps the step's
 * outbox back into the payload through `createOutboxOperation` (I2), so the
 * step carries the change and the side effect separately.
 */
function withoutOutbox(
  payload: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'outbox'))
}

/** The golden path of S06 (STORIES.md): Sam starts, then submits (ID-2, WF-1, I2, SE-1, FM-7). */
function submissionSteps(): readonly Step[] {
  const started = startInstance(flow, INSTANCE_ID, samData, SAM, depsFor(0), resolve, samGrants)
  const submitted = submitInstance(started.instance, SAM, depsFor(1), samData)

  return [
    {
      actor: started.operation.actor ?? SAM,
      type: started.operation.type,
      payload: started.operation.payload,
    },
    {
      actor: submitted.operation.actor ?? SAM,
      type: submitted.operation.type,
      payload: withoutOutbox(submitted.operation.payload),
      outbox: outboxOf(apply(submitted.operation, emptyState).log),
    },
  ]
}

export const golden = scenario({
  slug: 'start-submission',
  flowSlug: SLUG,
  steps: submissionSteps(),
  gui: [
    {
      actions: [
        { fill: { field: 'summary', value: 'three extra credits' } },
        { fill: { field: 'overload_credits', value: 3 } },
        { fill: { field: 'urgent', value: false } },
        { fill: { field: 'details', value: 'I need three extra credits to graduate on time.' } },
        { click: 'button[type="button"]' },
        { expect: 'Synced' },
      ],
    },
  ],
})
