import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import { createFlow, publish, push } from '../../engine/flow.js'
import type { OperationDeps } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'

// Issue #269, ID-3, AC-1, S06, A4: the shell of the interface. A flow that
// allows anonymous access says so on its form with a visible label (ID-3),
// the page carries one stylesheet, and a person who may not start a flow
// reads the server's refusal with the scope that would allow it (S06). The
// seed publishes one anonymous flow; Sam may start it and nobody else holds
// a grant.

/** The flow slug that the browser opens. */
export const SLUG = 'open-door'

/** The person who may start the flow, and one who may not (AC-1). */
export const SAM = 'user:sam'
export const NOBODY = 'user:nobody'

/** The definition: anonymous access on, one request step with one field (ID-3). */
export const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "anonymous": true,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }]
    }
  ]
}
`)

/** Sam may start the flow; nobody else holds a grant (AC-1). */
export const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The directory of the test (ID-4): a user target is its principal; the starter is whoever starts. */
export const resolve: TargetResolver = (target) =>
  'user' in target ? [target.user] : 'starter' in target ? [SAM] : []

/** The injected sources of the seed (I6): a fixed time and `flow-N` IDs. */
function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => 0,
    ids: () => {
      next += 1
      return `flow-${next}`
    },
  }
}

/** The published seed that the form reads the flow back from (DF-2). */
export function publishedState(): State {
  const sources = deps()
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}
