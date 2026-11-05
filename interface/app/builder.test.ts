import { expect, test } from 'vitest'
import {
  canBuild,
  conditionOf,
  conditionText,
  principalOfTarget,
  readModel,
  targetOf,
  treeOf,
  writeDefinition,
} from './builder.js'

// Issue #252, S08, AS-1, I12: the builder target input names a user, a starter,
// a directory group or a team, and it normalizes each to the target the engine
// publishes (AS-1). A group grant names `group:<id>`, which is the principal
// that the group resolver and `grantsFor` use (I10, I8).

test('#252 the builder normalizes group and team targets', () => {
  expect(targetOf('group:5f1c')).toEqual({ group: '5f1c' })
  expect(targetOf('team:registrar-office')).toEqual({ team: 'registrar-office' })
  expect(targetOf('user:person-1')).toEqual({ user: 'person-1' })
  expect(targetOf('person-1')).toEqual({ user: 'person-1' })
  expect(targetOf('starter')).toEqual({ starter: 'starter' })

  expect(principalOfTarget('group:5f1c')).toBe('group:5f1c')
  expect(principalOfTarget('team:registrar-office')).toBe('team:registrar-office')
  expect(principalOfTarget('user:person-1')).toBe('person-1')
  expect(principalOfTarget('person-1')).toBe('person-1')
})

// Issue #264, DF-1, DF-4, FM-1, FM-2, FM-3, FM-5, ID-3, WF-5, SE-3, SE-4,
// AS-3, S01, S05: the builder's model. It reads a v2 definition into the
// editable model and writes it back. Every setting the builder edits round
// trips (the flow's anonymous access, undo period and final step; a step's
// sections, visible and editable fields, takeover, timers, escalation
// targets, skip condition and rules), and every setting it does not edit (a
// field default, a connector read) is kept as it was, so a save never drops
// what another tool wrote (DF-4, I9).

const definition = {
  schemaVersion: 2,
  anonymous: true,
  undoHours: 48,
  finalStep: 'registrar',
  steps: [
    {
      key: 'request',
      targets: [{ starter: 'starter' }],
      sections: [
        {
          key: 'course',
          fields: [
            { key: 'summary', control: 'text', label: 'Summary', required: true },
            { key: 'overload_credits', control: 'number', label: 'Overload credits' },
          ],
        },
        {
          key: 'people',
          collapsed: true,
          fields: [{ key: 'advisor', control: 'user', default: { var: 'context.user' } }],
        },
      ],
      visible: ['summary', 'overload_credits', 'advisor'],
      editable: ['summary', 'overload_credits'],
      outcomes: ['submit'],
      rules: [
        { when: { '>': [{ var: 'overload_credits' }, 6] }, effect: 'require', targets: ['advisor'] },
      ],
    },
    {
      key: 'chair',
      targets: [{ group: 'CS-Chairs' }],
      outcomes: ['approve', 'send_back'],
      skipWhen: { '<=': [{ var: 'overload_credits' }, 2] },
      takeover: 'after-idle',
      idleMinutes: 240,
      reminderMinutes: 1440,
      deadlineMinutes: 4320,
      escalationTargets: [{ team: 'registrar-office' }],
    },
  ],
}

test.fails('#264the builder model reads a definition and writes it back unchanged (DF-4)', () => {
  const model = readModel(definition)
  expect(model.anonymous).toBe(true)
  expect(model.undoHours).toBe('48')
  expect(model.finalStep).toBe('registrar')
  const [request, chair] = model.steps
  expect(request?.sections.map((section) => section.key)).toEqual(['course', 'people'])
  expect(request?.sections[1]?.collapsed).toBe(true)
  expect(request?.fields.map((field) => [field.key, field.section])).toEqual([
    ['summary', 'course'],
    ['overload_credits', 'course'],
    ['advisor', 'people'],
  ])
  expect(request?.visible).toBe('summary, overload_credits, advisor')
  expect(request?.editable).toBe('summary, overload_credits')
  expect(request?.rules).toHaveLength(1)
  expect(request?.rules[0]?.effect).toBe('require')
  expect(request?.rules[0]?.targets).toBe('advisor')
  expect(chair?.takeover).toBe('after-idle')
  expect(chair?.idleMinutes).toBe('240')
  expect(chair?.escalationTargets).toBe('team:registrar-office')
  expect(chair?.skipWhen).toEqual({
    kind: 'compare',
    op: '<=',
    left: 'overload_credits',
    right: 2,
  })
  expect(writeDefinition(model)).toEqual(definition)
})

test.fails('#264the builder writes flat fields when a step has no section and the FM-3 lists it has', () => {
  const model = readModel({
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [{ key: 'summary', control: 'text' }],
        outcomes: ['submit'],
      },
    ],
  })
  const [request] = model.steps
  if (request === undefined) throw new Error('the model has no step')
  expect(request.sections).toEqual([])
  expect(request.visible).toBe('')
  // Without an editable list the builder keeps every field editable (FM-3).
  expect(request.editable).toBe('')
  request.fields.push({
    key: 'details',
    label: '',
    control: 'long-text',
    options: '',
    required: false,
    section: '',
  })
  expect(writeDefinition(model)).toEqual({
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [
          { key: 'summary', control: 'text' },
          { key: 'details', control: 'long-text' },
        ],
        editable: ['summary', 'details'],
        outcomes: ['submit'],
      },
    ],
  })
  // A section moves every field under the sections (FM-1): a step declares
  // one or the other, never both.
  request.sections.push({ key: 'main', collapsed: false })
  const written = writeDefinition(model).steps as Record<string, unknown>[]
  expect(written[0]?.fields).toBeUndefined()
  expect(written[0]?.sections).toEqual([
    {
      key: 'main',
      fields: [
        { key: 'summary', control: 'text' },
        { key: 'details', control: 'long-text' },
      ],
    },
  ])
})

// Issue #264, FM-2, FM-5, S05, ADR 0008: the condition builder writes one JSON
// Logic tree and reads one back. A comparison, a group and a negation are the
// visual forms; a tree the builder cannot express is kept as JSON text and
// written back as it was, so a rule written by hand is never lost (DF-4).

test.fails('#264the condition builder round-trips JSON Logic trees and shows them in words (FM-5)', () => {
  const labels = new Map([
    ['overload_credits', 'Overload credits'],
    ['advisor', 'Advisor'],
  ])
  const skip = { '<=': [{ var: 'overload_credits' }, 2] }
  const condition = conditionOf(skip)
  expect(condition).toEqual({ kind: 'compare', op: '<=', left: 'overload_credits', right: 2 })
  expect(treeOf(condition)).toEqual(skip)
  expect(conditionText(condition, labels)).toBe('Overload credits ≤ 2')

  const group = {
    and: [
      { '>': [{ var: 'overload_credits' }, 2] },
      { '!': [{ '==': [{ var: 'context.step' }, 'request'] }] },
      { in: [{ var: 'advisor' }, ['okafor', 'lin']] },
    ],
  }
  const read = conditionOf(group)
  expect(treeOf(read)).toEqual(group)
  expect(conditionText(read, labels)).toBe(
    'Overload credits > 2 and not (Step = request) and Advisor in okafor, lin'
  )

  const other = { if: [{ var: 'summary' }, true, false] }
  const kept = conditionOf(other)
  expect(kept.kind).toBe('json')
  expect(treeOf(kept)).toEqual(other)
  expect(conditionText(kept, labels)).toBe(JSON.stringify(other))
})

// Issue #264, DF-5, S03: the builder reads the signed-in person's grants and
// disables the structural controls when they hold `flow.edit` and not
// `flow.build`. The check is a presentation convenience; the server refuses
// the change again (AC-1, I8).

test.fails('#264the builder knows who may make a structural change (DF-5)', () => {
  const slug = 'course-overload'
  expect(canBuild([{ principal: 'priya', scopes: ['flow.edit'], resource: `flow:${slug}` }], slug))
    .toBe(false)
  expect(canBuild([{ principal: 'dana', scopes: ['flow.build'], resource: `flow:${slug}` }], slug))
    .toBe(true)
  expect(canBuild([{ principal: 'dana', scopes: ['flow.build'], resource: 'flow:*' }], slug)).toBe(
    true
  )
  expect(canBuild([{ principal: 'dana', scopes: ['flow.build'], resource: 'flow:other' }], slug))
    .toBe(false)
  expect(canBuild([], slug)).toBe(false)
})
