import { expect, test } from 'vitest'
import { type Control, controlKind, formModel, isSingleInput } from './form.js'

// Issue #181, FM-1, FM-3, FM-7, A9: the form model narrows a v2 flow
// definition as it arrives from readFlow and answers what a step's form looks
// like. It reads the fields and sections of the step, the sixteen FM-1
// controls, the option list of a choice control, the required flag, the
// per-step visible and editable field keys (FM-3), and the current value from
// the values that the form holds (FM-7). The model is a presentation view
// only: the engine stays authoritative for validation, authorization and
// routing (A9, FM-3).

test('#181 the form model reads a flat step and its visible and editable fields', () => {
  const definition = {
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [
          { key: 'summary', control: 'text', label: 'Summary', required: true },
          { key: 'details', control: 'long-text' },
          { key: 'credits', control: 'number' },
          { key: 'advisor', control: 'select', options: ['Dr. Okafor', 'Dr. Lin'], required: true },
          { key: 'newsletter', control: 'checkbox' },
        ],
        visible: ['summary', 'details', 'credits', 'advisor'],
        editable: ['summary', 'details', 'advisor'],
      },
    ],
  }
  const values = { summary: 'three extra credits', credits: 3, newsletter: true }

  const model = formModel(definition, 'request', values)

  // The model names the step, keeps the visible fields in definition order and
  // drops the hidden newsletter field (FM-3).
  expect(model.stepKey).toBe('request')
  expect(model.sections).toEqual([])
  expect(model.fields.map((field) => field.key)).toEqual([
    'summary',
    'details',
    'credits',
    'advisor',
  ])

  const byKey = Object.fromEntries(model.fields.map((field) => [field.key, field]))
  expect(byKey.summary).toEqual({
    key: 'summary',
    control: 'text',
    label: 'Summary',
    options: [],
    required: true,
    editable: true,
    value: 'three extra credits',
  })
  expect(byKey.details).toEqual({
    key: 'details',
    control: 'long-text',
    options: [],
    required: false,
    editable: true,
  })
  expect(byKey.credits).toEqual({
    key: 'credits',
    control: 'number',
    options: [],
    required: false,
    editable: false,
    value: 3,
  })
  expect(byKey.advisor).toEqual({
    key: 'advisor',
    control: 'select',
    options: ['Dr. Okafor', 'Dr. Lin'],
    required: true,
    editable: true,
  })
})

test('#181 the form model reads sections and the absent visible and editable defaults', () => {
  const definition = {
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        sections: [
          { key: 'about', fields: [{ key: 'summary', control: 'text' }] },
          {
            key: 'course',
            fields: [
              { key: 'credits', control: 'number' },
              { key: 'advisor', control: 'select', options: ['Dr. Okafor'] },
            ],
          },
        ],
      },
    ],
  }

  const model = formModel(definition, 'request')

  // A step shows its form as sections or as flat fields, never both (FM-1).
  expect(model.fields).toEqual([])
  expect(model.sections.map((section) => section.key)).toEqual(['about', 'course'])
  expect(model.sections[0].fields.map((field) => field.key)).toEqual(['summary'])
  expect(model.sections[1].fields.map((field) => field.key)).toEqual(['credits', 'advisor'])

  // An absent visible means every field shows, and an absent editable means no
  // field is editable (FM-3).
  for (const section of model.sections) {
    for (const field of section.fields) {
      expect(field.editable).toBe(false)
    }
  }
})

test('#181 the form model refuses a schemaVersion it does not read', () => {
  expect(() => formModel({ schemaVersion: 9, steps: [] }, 'request')).toThrow(/schemaVersion 9/)
})

test('#181 the form model maps each FM-1 control to what the DOM needs', () => {
  const kinds: Record<Control, string> = {
    text: 'single-line',
    'long-text': 'textarea',
    number: 'number',
    money: 'number',
    date: 'single-line',
    select: 'select',
    'multi-select': 'checkboxes',
    checkbox: 'switch',
    radio: 'radios',
    'yes-no': 'switch',
    email: 'single-line',
    phone: 'single-line',
    file: 'file',
    user: 'person',
    static: 'static',
    repeating: 'repeating',
  }
  for (const [control, kind] of Object.entries(kinds)) {
    expect(controlKind(control as Control), control).toBe(kind)
  }

  const single = ['text', 'number', 'money', 'date', 'email', 'phone']
  for (const control of single) {
    expect(isSingleInput(control as Control), control).toBe(true)
  }
  const notSingle = [
    'long-text',
    'select',
    'multi-select',
    'checkbox',
    'radio',
    'yes-no',
    'file',
    'user',
    'static',
    'repeating',
  ]
  for (const control of notSingle) {
    expect(isSingleInput(control as Control), control).toBe(false)
  }
})
