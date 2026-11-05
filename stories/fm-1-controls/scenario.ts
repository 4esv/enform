import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import type { ConditionData } from '../../engine/condition.js'
import { type FlowDefinition, type JsonValue, parse } from '../../engine/definition.js'
import { createFlow, type Flow, type FlowVersion, publish, push } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { editDraft, startInstance } from '../../engine/submission.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'
import { declared } from '../example-flow.js'

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

/**
 * What the page holds when the first control changes (FM-1, #262): the typed
 * text, and every other control's reading. A number, a date, a file and a
 * repeating section read nothing when empty; a text reads an empty string; a
 * select reads its first option; a radio group reads null; a checkbox group
 * reads an empty list.
 */
const firstChange: ConditionData = {
  text: 'hello',
  'long-text': '',
  select: 'one',
  'multi-select': [],
  checkbox: false,
  radio: null,
  'yes-no': null,
  email: '',
  phone: '',
  user: '',
}

/** The edits the page posts after the first change, one per control change, in fill order. */
const edits: readonly Readonly<Record<string, JsonValue>>[] = [
  { 'long-text': 'a longer answer' },
  { number: 3 },
  { money: 12.5 },
  { date: '2026-10-10' },
  // The select already read its first option, so choosing it posts nothing;
  // the two checks of the group land within one pause, so they post once.
  { 'multi-select': ['one', 'two'] },
  { checkbox: true },
  { radio: 'two' },
  { 'yes-no': 'yes' },
  { email: 'sam@example.org' },
  { phone: '+1 555 0100' },
  { file: 'upload.txt' },
  { user: 'user:sam' },
  { repeating: [{ key: 'value' }] },
  values as Readonly<Record<string, JsonValue>>,
]

/** The golden steps of the page (FM-1, FM-7, RT-3): the start on the first change, then one draft edit per change and the Save. */
function startSteps(): readonly Step[] {
  const steps: Step[] = []
  const started = startInstance(flow, INSTANCE_ID, firstChange, SAM, depsFor(0), resolve, samGrants)
  steps.push(
    declared(started.operation, { flow: SLUG, instanceId: INSTANCE_ID, values: firstChange })
  )
  let instance = started.instance
  for (const edit of edits) {
    const edited = editDraft(instance, SAM, edit, depsFor(steps.length))
    if (edited.operation === undefined) throw new Error(edited.reason)
    instance = edited.instance
    steps.push(declared(edited.operation, { instanceId: INSTANCE_ID, values: edit }))
  }
  return steps
}

export const golden = scenario({
  slug: 'fm-1-controls',
  flowSlug: SLUG,
  bootstrap: samGrants,
  steps: startSteps(),
  gui: [
    {
      steps: 15,
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
        { expectText: { selector: '[data-sync-for="text"]', text: 'Synced' } },
        { fill: { field: 'long-text', value: 'a longer answer' } },
        { expectText: { selector: '[data-sync-for="long-text"]', text: 'Synced' } },
        { fill: { field: 'number', value: 3 } },
        { expectText: { selector: '[data-sync-for="number"]', text: 'Synced' } },
        { fill: { field: 'money', value: 12.5 } },
        { expectText: { selector: '[data-sync-for="money"]', text: 'Synced' } },
        { fill: { field: 'date', value: '2026-10-10' } },
        { expectText: { selector: '[data-sync-for="date"]', text: 'Synced' } },
        { fill: { field: 'select', value: 'one' } },
        { fill: { field: 'multi-select', value: ['one', 'two'] } },
        { expectText: { selector: '[data-sync-for="multi-select"]', text: 'Synced' } },
        { fill: { field: 'checkbox', value: true } },
        { expectText: { selector: '[data-sync-for="checkbox"]', text: 'Synced' } },
        { fill: { field: 'radio', value: 'two' } },
        { expectText: { selector: '[data-sync-for="radio"]', text: 'Synced' } },
        { fill: { field: 'yes-no', value: 'yes' } },
        { expectText: { selector: '[data-sync-for="yes-no"]', text: 'Synced' } },
        { fill: { field: 'email', value: 'sam@example.org' } },
        { expectText: { selector: '[data-sync-for="email"]', text: 'Synced' } },
        { fill: { field: 'phone', value: '+1 555 0100' } },
        { expectText: { selector: '[data-sync-for="phone"]', text: 'Synced' } },
        { fill: { field: 'file', value: 'upload.txt' } },
        { expectText: { selector: '[data-sync-for="file"]', text: 'Synced' } },
        { fill: { field: 'user', value: 'user:sam' } },
        { expectText: { selector: '[data-sync-for="user"]', text: 'Synced' } },
        { click: '[data-add-row="repeating"]' },
        { fill: { field: 'repeating', value: '{"key":"value"}' } },
        { expectText: { selector: '[data-sync-for="repeating"]', text: 'Synced' } },
        { click: '[data-start]' },
        { expect: 'Synced' },
      ],
    },
  ],
})
