import type { ConditionData } from '../../engine/condition.js'
import {
  type FlowDefinition,
  type FlowStep,
  type JsonValue,
  parse,
} from '../../engine/definition.js'

// S05: Dana skips the chair step for a small overload (STORIES.md). The chair
// step carries a skip condition, a JSON Logic expression (FM-5, WF-1): when
// the request has at most two overload credits, the chair is skipped and the
// timeline records the skip. The flow is the example flow of STORIES.md with
// the chair step; the two data fixtures drive the condition. The path is
// deterministic (I6): it reads no clock and no random source.

/** The flow of the story: request, advisor, the conditional chair, and registrar (DF-1). */
export const draft: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve", "send_back"] },
    { "key": "chair", "targets": [{ "group": "CS-Chairs" }], "outcomes": ["approve", "send_back"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] } },
    { "key": "registrar", "targets": [{ "field": "registrar" }], "outcomes": ["record"] }
  ]
}
`)

/** The skip condition of the chair step (S05, FM-5): the overload credit limit. */
export const chairSkipWhen: JsonValue = { '<=': [{ var: 'overload_credits' }, 2] }

/** The chair step, the one conditional step of the story (S05). */
export const chairStep: FlowStep = draft.steps[2]

/** The data of a small overload: two credits, so the chair is skipped (S05). */
export const smallOverload: ConditionData = { overload_credits: 2 }

/** The data of a large overload: four credits, so the chair is active (S05). */
export const largeOverload: ConditionData = { overload_credits: 4 }
