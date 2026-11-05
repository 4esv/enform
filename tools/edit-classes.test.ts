import { expect, test } from 'vitest'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { classifyChange } from '../engine/edit.js'

// Issue #256, DF-5, DF-6, D2, S03, S04: the change class and the diff name
// every field-level difference. An edit-class change touches a label, help
// text or an option list and needs `flow.edit`; everything else that changes
// the shape of the flow, a field, a control, a requirement, a section, a rule,
// a timer, a takeover or a flow setting, is structural and needs `flow.build`.
// Each difference names the path it sits at, so a diff view and a refusal
// point at the exact place (DF-6).

function flow(body: string): FlowDefinition {
  return parse(body)
}

const base = flow(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "sections": [
        {
          "key": "about",
          "fields": [
            { "key": "summary", "control": "text", "label": "Summary", "required": true },
            { "key": "reason", "control": "select", "options": ["travel", "research"] }
          ]
        }
      ],
      "editable": ["summary", "reason"]
    },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] }
  ]
}
`)

test('#256 DF-5 a label and an option change are edit-class, with a path (S03)', () => {
  const edited = flow(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "sections": [
        {
          "key": "about",
          "fields": [
            { "key": "summary", "control": "text", "label": "Short summary", "required": true },
            { "key": "reason", "control": "select", "options": ["travel", "research", "teaching"] }
          ]
        }
      ],
      "editable": ["summary", "reason"]
    },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] }
  ]
}
`)
  expect(classifyChange(base, edited)).toEqual([
    {
      class: 'edit',
      message: 'the label of field summary in step request changed',
      path: '/steps/request/sections/about/fields/summary/label',
      before: 'Summary',
      after: 'Short summary',
    },
    {
      class: 'edit',
      message: 'an option was added to field reason in step request: teaching',
      path: '/steps/request/sections/about/fields/reason/options',
      before: ['travel', 'research'],
      after: ['travel', 'research', 'teaching'],
    },
  ])
  expect(classifyChange(base, base)).toEqual([])
})

test('#256 DF-5 a field, a control, a requirement, a rule, a timer and a setting are structural (S04)', () => {
  const changed = flow(`{
  "schemaVersion": 2,
  "anonymous": true,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "sections": [
        {
          "key": "about",
          "fields": [
            { "key": "summary", "control": "long-text", "label": "Summary" },
            { "key": "reason", "control": "select", "options": ["travel", "research"] },
            { "key": "reason_category", "control": "text", "required": true }
          ]
        }
      ],
      "editable": ["summary", "reason", "reason_category"],
      "rules": [{ "when": { "==": [{ "var": "reason" }, "travel"] }, "effect": "require", "targets": ["summary"] }]
    },
    {
      "key": "advisor",
      "targets": [{ "user": "user:okafor" }],
      "outcomes": ["approve"],
      "reminderMinutes": 60,
      "takeover": "always"
    }
  ]
}
`)
  const changes = classifyChange(base, changed)
  expect(changes.every((change) => change.class === 'structural')).toBe(true)
  expect(changes.map((change) => (change as { path?: string }).path)).toEqual([
    '/anonymous',
    '/steps/request/sections/about/fields/summary/control',
    '/steps/request/sections/about/fields/summary/required',
    '/steps/request/sections/about/fields/reason_category',
    '/steps/request/editable',
    '/steps/request/rules',
    '/steps/advisor/takeover',
    '/steps/advisor/reminderMinutes',
  ])
  expect(changes.map((change) => change.message)).toContain(
    'a field was added to step request: reason_category'
  )
})
