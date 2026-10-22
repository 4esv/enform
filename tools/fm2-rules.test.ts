import { expect, test } from 'vitest'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, type FlowStep, parse } from '../engine/definition.js'
import { contentHash } from '../engine/instance.js'
import { type InstanceView, type ProjectedInstance, readInstance } from '../engine/instances.js'
import type { ActorId } from '../engine/operation.js'
import { evaluateRules } from '../engine/rules.js'

// Issue #75, FM-2, FM-5, FM-1, FM-7, I6, A9: the rules of a step, in the
// server's view of the form. FM-2: conditions on the data, the step and the
// user show, hide, collapse, require or lock sections and fields. The
// condition data is the instance's values at the root plus the reserved
// `context` root (`context.step`, `context.user`); the rules apply in document
// order, a later rule wins per target and per property, and a false condition
// keeps the default. `skip` drops the target from the capture, and the read
// returns the visible, editable, required and collapsed state; it is pure and
// deterministic (I6).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'
const INSTANCE_ID = 'inst-1'
const STEP_KEY = 'request'

/** Sam's grants (AC-1, AC-4): he may start the flow and submit the request step. */
const samGrants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
]

/**
 * A step whose rules the checks vary (FM-2, FM-3). The step shows `summary` and
 * `note` and hides `urgent`, so a `show` rule has a field to reveal. It carries
 * two sections: `details` (not collapsed) and `extra` (collapsed by its FM-1
 * default). `summary` is required and the only editable field.
 */
function stepWith(rules: string): FlowStep {
  const definition: FlowDefinition = parse(`{
    "schemaVersion": 2,
    "steps": [
      {
        "key": "${STEP_KEY}",
        "targets": [{ "starter": "starter" }],
        "sections": [
          {
            "key": "details",
            "fields": [
              { "key": "summary", "control": "text", "required": true },
              { "key": "urgent", "control": "yes-no" }
            ]
          },
          {
            "key": "extra",
            "fields": [{ "key": "note", "control": "text" }],
            "collapsed": true
          }
        ],
        "visible": ["summary", "note"],
        "editable": ["summary"],
        "outcomes": ["submit"],
        "rules": ${rules}
      }
    ]
  }`)
  return definition.steps[0]
}

/** The definition that holds one step, so the read can pin an instance to it (DF-2). */
function definitionFor(step: FlowStep): FlowDefinition {
  return { schemaVersion: 2, steps: [step] }
}

/** The instance the step is on, with the values the form holds (FM-7). */
function instanceFor(step: FlowStep, values: ConditionData): ProjectedInstance {
  return {
    instanceId: INSTANCE_ID,
    flow: SLUG,
    definitionVersion: contentHash(definitionFor(step)),
    assignees: [{ step: step.key, target: { starter: 'starter' }, members: [SAM] }],
    connectorCalls: [],
    values,
    starter: SAM,
    currentStep: step.key,
    submitted: false,
    version: 0,
  }
}

/** The view of one step for one actor, through the same read the API serves (FM-3, FM-7, I8). */
function viewFor(
  step: FlowStep,
  values: ConditionData,
  actor: ActorId,
  grants: readonly Grant[]
): InstanceView {
  const definition = definitionFor(step)
  const view = readInstance(actor, instanceFor(step, values), {
    flow: SLUG,
    definition,
    log: [],
    grants,
  })
  if (view === undefined) throw new Error('the instance is not readable')
  return view
}

test('#75 FM-2 a show rule shows a field the step does not make visible', () => {
  const step = stepWith(`[{ "when": true, "effect": "show", "targets": ["urgent"] }]`)
  const state = evaluateRules(step, {}, SAM)
  // The step does not list `urgent`, so its default is hidden (FM-3); the rule
  // shows it.
  expect(state.fields.urgent.visible).toBe(true)
  expect(state.fields.summary.visible).toBe(true)
})

test('#75 FM-2 a hide rule hides a field and a hidden section hides its fields', () => {
  const step = stepWith(`[
    { "when": true, "effect": "hide", "targets": ["summary"] },
    { "when": true, "effect": "hide", "targets": ["section:extra"] }
  ]`)
  const state = evaluateRules(step, {}, SAM)
  expect(state.fields.summary.visible).toBe(false)
  expect(state.sections.extra.visible).toBe(false)
  // The hidden section hides its field, although the step makes it visible.
  expect(state.fields.note.visible).toBe(false)
})

test('#75 FM-2 a collapse rule collapses a section and a section keeps its default', () => {
  const step = stepWith(`[{ "when": true, "effect": "collapse", "targets": ["section:details"] }]`)
  const state = evaluateRules(step, {}, SAM)
  expect(state.sections.details.collapsed).toBe(true)
  // `extra` carries its FM-1 presentation default when no rule changes it.
  expect(state.sections.extra.collapsed).toBe(true)
  // `details` is not collapsed without the rule.
  expect(evaluateRules(stepWith('[]'), {}, SAM).sections.details.collapsed).toBe(false)
})

test('#75 FM-2 a require rule requires a field, and a hidden field is not required', () => {
  // `note` is shown by the step, so the rule adds it to the required set.
  const shown = stepWith(`[{ "when": true, "effect": "require", "targets": ["note"] }]`)
  expect(evaluateRules(shown, {}, SAM).fields.note.required).toBe(true)
  // `urgent` is not shown, so a rule cannot require it.
  const hidden = stepWith(`[{ "when": true, "effect": "require", "targets": ["urgent"] }]`)
  expect(evaluateRules(hidden, {}, SAM).fields.urgent.required).toBe(false)
  // `summary` is required by the definition, so it is required with no rule.
  expect(evaluateRules(stepWith('[]'), {}, SAM).fields.summary.required).toBe(true)
})

test('#75 FM-2 a lock rule removes editability and never grants it', () => {
  const step = stepWith(`[
    { "when": true, "effect": "lock", "targets": ["summary"] },
    { "when": true, "effect": "lock", "targets": ["urgent"] }
  ]`)
  // `summary` was the one editable field; the lock removes it. `urgent` was
  // never editable, so the lock cannot grant editability.
  const read = viewFor(step, {}, SAM, samGrants)
  expect(read.editable).toEqual([])
})

test('#75 FM-2 a skip rule drops the field from the view and keeps the value', () => {
  const step = stepWith(`[{ "when": true, "effect": "skip", "targets": ["note"] }]`)
  const instance = instanceFor(step, { summary: 'hello', note: 'kept' })
  const read = readInstance(SAM, instance, {
    flow: SLUG,
    definition: definitionFor(step),
    log: [],
    grants: samGrants,
  })
  if (read === undefined) throw new Error('the instance is not readable')
  // A skipped field is absent from the view's visible and from the values.
  expect(read.visible).toEqual(['summary'])
  expect(read.values).toEqual({ summary: 'hello' })
  expect(Object.hasOwn(read.values, 'note'), 'a skipped field is absent, not null').toBe(false)
  // The recorded value stays on the instance: skip drops the capture, not the log.
  expect(instance.values?.note).toBe('kept')
})

test('#75 FM-2 a false condition keeps the default state', () => {
  const step = stepWith(`[
    { "when": { "==": [1, 2] }, "effect": "hide", "targets": ["summary"] },
    { "when": { "==": [1, 2] }, "effect": "collapse", "targets": ["section:details"] },
    { "when": { "==": [1, 2] }, "effect": "require", "targets": ["note"] },
    { "when": { "==": [1, 2] }, "effect": "lock", "targets": ["summary"] },
    { "when": { "==": [1, 2] }, "effect": "skip", "targets": ["note"] }
  ]`)
  const state = evaluateRules(step, {}, SAM)
  expect(state.fields.summary.visible).toBe(true)
  expect(state.fields.summary.locked).toBe(false)
  expect(state.fields.note.required).toBe(false)
  expect(state.fields.note.skipped).toBe(false)
  expect(state.sections.details.collapsed).toBe(false)
})

test('#75 FM-2 a condition reads the data, the step and the user through context', () => {
  const step = stepWith(`[
    { "when": { "==": [{ "var": "urgent" }, true] }, "effect": "require", "targets": ["note"] },
    { "when": { "==": [{ "var": "context.step" }, "request"] }, "effect": "show", "targets": ["urgent"] },
    { "when": { "==": [{ "var": "context.user" }, "user:okafor"] }, "effect": "hide", "targets": ["note"] }
  ]`)
  // A condition on the data.
  expect(evaluateRules(step, { urgent: true }, SAM).fields.note.required).toBe(true)
  expect(evaluateRules(step, { urgent: false }, SAM).fields.note.required).toBe(false)
  // A condition on the step: `context.step` is the step the rules belong to.
  expect(evaluateRules(step, { urgent: false }, SAM).fields.urgent.visible).toBe(true)
  // A condition on the user: the same rule hides `note` for Okafor alone.
  expect(evaluateRules(step, { urgent: false }, OKAFOR).fields.note.visible).toBe(false)
  expect(evaluateRules(step, { urgent: false }, SAM).fields.note.visible).toBe(true)
})

test('#75 FM-2 a skipped field is not required', () => {
  const step = stepWith(`[{ "when": true, "effect": "skip", "targets": ["summary"] }]`)
  const read = viewFor(step, {}, SAM, samGrants)
  // `summary` is required by the definition, but a skipped field is impossible
  // to fill, so it is not required. `note` is not required either.
  expect(read.visible).toEqual(['note'])
  expect(read.required).toEqual([])
})

test('#75 FM-2 the parser refuses a field key named context', () => {
  const flat = `{ "schemaVersion": 2, "steps": [ { "key": "s", "targets": [{ "user": "user:sam" }], "fields": [{ "key": "context", "control": "text" }] } ] }`
  const section = `{ "schemaVersion": 2, "steps": [ { "key": "s", "targets": [{ "user": "user:sam" }], "sections": [{ "key": "g", "fields": [{ "key": "context", "control": "text" }] }] } ] }`
  // `context` is the reserved root of a condition (FM-2), so no field may shadow it.
  expect(() => parse(flat)).toThrow(/context is a reserved field key/)
  expect(() => parse(section)).toThrow(/context is a reserved field key/)
})

test('#75 FM-2 the step read reflects every effect and is deterministic', () => {
  const step = stepWith(`[
    { "when": true, "effect": "show", "targets": ["urgent"] },
    { "when": true, "effect": "hide", "targets": ["note"] },
    { "when": true, "effect": "skip", "targets": ["note"] },
    { "when": true, "effect": "require", "targets": ["urgent"] },
    { "when": true, "effect": "collapse", "targets": ["section:details"] },
    { "when": true, "effect": "lock", "targets": ["summary"] }
  ]`)
  const values: ConditionData = { summary: 'hello', urgent: true, note: 'kept' }
  const read = viewFor(step, values, SAM, samGrants)
  expect(read.visible).toEqual(['summary', 'urgent'])
  expect(read.required).toEqual(['summary', 'urgent'])
  expect(read.collapsed).toEqual(['details', 'extra'])
  expect(read.editable).toEqual([])
  expect(read.values).toEqual({ summary: 'hello', urgent: true })
  // The same inputs give the same view (I6).
  expect(viewFor(step, values, SAM, samGrants)).toEqual(read)
})
