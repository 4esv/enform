import { claim } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import { createFlow, type Flow, type FlowVersion, publish, push } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { startInstance } from '../../engine/submission.js'

// Issue #106, FM-3, FM-4, FM-7, A9, I12, ADR 0009: the requirement test for
// #106 criterion 2 and FM-4. Dr. Okafor holds the request step, opens the task
// page and completes it. The server runs the step's rules and validation
// again and refuses an empty required field with every error named by path,
// so the browser can show the reason at the control that failed (FM-4). The
// seed starts the instance as Sam and claims the step as Dr. Okafor, because
// the engine completes only for the holder (AS-2, AC-4).

/** The flow slug that the browser opens. */
export const SLUG = 'refusal'

/** The instance id that the start mints (DX-1, #187), deterministic like every injected source (I6). */
export const INSTANCE_ID = 'inst-refusal'

/** Sam starts the submission; Dr. Okafor holds the request step (S06, S09). */
export const SAM = 'user:sam'
export const OKAFOR = 'user:okafor'

/** The one step of the flow, and the one outcome that Dr. Okafor may choose (AC-4). */
export const STEP = 'request'
export const OUTCOME = 'approve'

/** The resource of the request step (MVP.md 5.6). */
export const STEP_RESOURCE = `flow:${SLUG}/step:${STEP}`

/** The definition: one request step with a required summary, all fields editable (FM-3, FM-4). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "user": "${OKAFOR}" }],
      "outcomes": ["${OUTCOME}"],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "details", "control": "long-text" },
        { "key": "urgent", "control": "checkbox" }
      ],
      "editable": ["summary", "details", "urgent"]
    }
  ]
}
`)

/** The published version: a start needs a version with a content hash (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definition),
  definition,
}

/** The flow of the requirement test. */
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/** Sam may start the flow, and Dr. Okafor may choose the approve outcome (AC-1, AC-4). */
export const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: OKAFOR, scopes: [`step.outcome:${OUTCOME}`], resource: STEP_RESOURCE },
]

/** The directory of the test (ID-4): a user target resolves to its principal, and no other kind resolves. */
export const resolve: TargetResolver = (target) => ('user' in target ? [target.user] : [])

/** The injected sources of the seed (I6): a fixed time and `prefix-N` IDs. */
function deps(prefix: string): OperationDeps {
  let next = 0
  return {
    clock: () => 0,
    ids: () => {
      next += 1
      return `${prefix}-${next}`
    },
  }
}

/** The published seed that the browser reads the flow back from (DF-2), as S06 builds it. */
export function publishedState(): State {
  const sources = deps('flow')
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/**
 * The seed that the task page reads: the flow published, Sam's start (S06)
 * and Dr. Okafor's claim of the request step (S09, AS-2), so the instance has
 * a holder to complete. The claim advances the instance to version 1, the
 * version that the completion is based on (I5).
 */
export function claimedState(): State {
  const sources = deps('request')
  const started = startInstance(flow, INSTANCE_ID, {}, SAM, sources, resolve, grants)
  const claimed = claim(started.instance, OKAFOR, started.instance.version ?? 0, sources)
  if (!claimed.accepted || claimed.operation === undefined) {
    throw new Error(`the seed claim was refused: ${claimed.reason}`)
  }
  const state = apply(started.operation, publishedState())
  return apply(claimed.operation, state)
}
