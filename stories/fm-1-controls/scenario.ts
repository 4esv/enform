import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, parse } from '../../engine/definition.js'
import { createFlow, type Flow, type FlowVersion, publish, push } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { startInstance } from '../../engine/submission.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'

// Issue #106, FM-1, FM-3, FM-7: the requirement test for FM-1. No story cites
// FM-1, so MVP.md section 13 (the #99 entry) makes a requirement test its
// evidence. The fixture declares one step with one field of each of the
// sixteen controls, all editable, so the browser must render each control and
// the start must record the value it collects. The engine's validator is the
// authority: the values below are the valid value table of tools/fields.test.ts.

/** The flow slug that the browser opens. */
export const SLUG = 'controls'

/** The instance id that the start mints (DX-1, #187), deterministic like every injected source (I6). */
export const INSTANCE_ID = 'inst-controls'

/** The definition of the requirement test: one step, one field of each control (FM-1). */
export const definitionV2: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "user": "user:sam" }],
      "fields": [
        { "key": "text", "control": "text" },
        { "key": "long-text", "control": "long-text" },
        { "key": "number", "control": "number" },
        { "key": "money", "control": "money" },
        { "key": "date", "control": "date" },
        { "key": "select", "control": "select", "options": ["one", "two"] },
        { "key": "multi-select", "control": "multi-select", "options": ["one", "two"] },
        { "key": "checkbox", "control": "checkbox" },
        { "key": "radio", "control": "radio", "options": ["one", "two"] },
        { "key": "yes-no", "control": "yes-no" },
        { "key": "email", "control": "email" },
        { "key": "phone", "control": "phone" },
        { "key": "file", "control": "file" },
        { "key": "user", "control": "user" },
        { "key": "static", "control": "static" },
        { "key": "repeating", "control": "repeating" }
      ],
      "editable": [
        "text",
        "long-text",
        "number",
        "money",
        "date",
        "select",
        "multi-select",
        "checkbox",
        "radio",
        "yes-no",
        "email",
        "phone",
        "file",
        "user",
        "repeating"
      ]
    }
  ]
}
`)

/** The published version: a start needs a version with a content hash (DF-2). */
export const versionV2: FlowVersion = {
  version: 1,
  contentHash: contentHash(definitionV2),
  definition: definitionV2,
}

/** The flow of the requirement test. */
export const flow: Flow = { slug: SLUG, versions: [versionV2] }

/** The published seed that the browser reads the flow back from (DF-2), as S06 builds it. */
export function flowState(): State {
  const deps = (id: string): OperationDeps => ({ clock: () => 0, ids: () => id })
  const pushed = push(createFlow(SLUG), definitionV2, deps('flow-push'), 'user:dana')
  const published = publish(pushed.flow, deps('flow-publish'), 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/**
 * The values that the browser must submit: the engine's valid value for each
 * control (tools/fields.test.ts), with the chosen file named upload.txt. A
 * static control takes no value, so it contributes no key.
 */
export const values: ConditionData = {
  text: 'hello',
  'long-text': 'a longer answer',
  number: 3,
  money: 12.5,
  date: '2026-10-10',
  select: 'one',
  'multi-select': ['one', 'two'],
  checkbox: true,
  radio: 'two',
  'yes-no': 'yes',
  email: 'sam@example.org',
  phone: '+1 555 0100',
  file: 'upload.txt',
  user: 'user:sam',
  repeating: [{ key: 'value' }],
}

/** Sam holds instance.start on the flow (AC-1, ID-4). */
export const samGrants: readonly Grant[] = [
  { principal: 'user:sam', scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The directory of the test (ID-4): a user target resolves to its principal, and no other kind resolves. */
export const resolve: TargetResolver = (target) => ('user' in target ? [target.user] : [])

/** Sam, the signed-in principal who starts the submission (S06, ID-2). */
const SAM = 'user:sam'

/** The runner's injected sources (I6): the clock is the step index and the IDs are `op-N`. */
function depsFor(index: number): OperationDeps {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

/** The golden step of the start (FM-1, FM-7), built through the engine with the same sources. */
function startSteps(): readonly Step[] {
  const started = startInstance(flow, INSTANCE_ID, values, SAM, depsFor(0), resolve, samGrants)
  return [
    {
      actor: started.operation.actor ?? SAM,
      type: started.operation.type,
      payload: started.operation.payload,
    },
  ]
}

export const golden = scenario({
  slug: 'fm-1-controls',
  flowSlug: SLUG,
  steps: startSteps(),
  gui: [
    {
      actions: [
        { expectDom: { field: 'text', tag: 'input', type: 'text' } },
        { expectDom: { field: 'long-text', tag: 'textarea' } },
        { expectDom: { field: 'number', tag: 'input', type: 'number' } },
        { expectDom: { field: 'money', tag: 'input', type: 'number' } },
        { expectDom: { field: 'date', tag: 'input', type: 'date' } },
        { expectDom: { field: 'select', tag: 'select' } },
        { expectDom: { field: 'multi-select', tag: 'input', type: 'checkbox', count: 2 } },
        { expectDom: { field: 'checkbox', tag: 'input', type: 'checkbox' } },
        { expectDom: { field: 'radio', tag: 'input', type: 'radio', count: 2 } },
        { expectDom: { field: 'yes-no', tag: 'input', type: 'radio', count: 2 } },
        { expectDom: { field: 'email', tag: 'input', type: 'email' } },
        { expectDom: { field: 'phone', tag: 'input', type: 'tel' } },
        { expectDom: { field: 'file', tag: 'input', type: 'file' } },
        { expectDom: { field: 'user', tag: 'input', type: 'text' } },
        { expectDom: { field: 'static', tag: 'div' } },
        { expectDom: { field: 'repeating', tag: 'fieldset' } },
        { fill: { field: 'text', value: 'hello' } },
        { fill: { field: 'long-text', value: 'a longer answer' } },
        { fill: { field: 'number', value: 3 } },
        { fill: { field: 'money', value: 12.5 } },
        { fill: { field: 'date', value: '2026-10-10' } },
        { fill: { field: 'select', value: 'one' } },
        { fill: { field: 'multi-select', value: ['one', 'two'] } },
        { fill: { field: 'checkbox', value: true } },
        { fill: { field: 'radio', value: 'two' } },
        { fill: { field: 'yes-no', value: 'yes' } },
        { fill: { field: 'email', value: 'sam@example.org' } },
        { fill: { field: 'phone', value: '+1 555 0100' } },
        { fill: { field: 'file', value: 'upload.txt' } },
        { fill: { field: 'user', value: 'user:sam' } },
        { click: '[data-add-row="repeating"]' },
        { fill: { field: 'repeating', value: '{"key":"value"}' } },
        { click: 'button[type="button"]' },
        { expect: 'Synced' },
      ],
    },
  ],
})
