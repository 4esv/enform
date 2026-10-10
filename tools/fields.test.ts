import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  CONTROL_TYPES,
  type ControlType,
  type Field,
  parse,
  serialize,
} from '../engine/definition.js'
import { validateField } from '../engine/fields.js'

// Issue #74, FM-1, FM-4, DF-1, I9, I6, A3: a step declares form fields, and
// each field is one of the sixteen controls of FM-1: text, long text, number,
// money, date, select, multi-select, checkbox, radio, yes/no, email, phone,
// file upload, user picker, static text and a repeating section. The field is
// a change to the flow definition format (DF-1), so the published JSON Schema
// changes with the code and the canonical file form carries the fields through
// the round trip byte for byte (I9). The server validates a submitted value
// against its control at each submission (FM-4), and the check is pure and
// deterministic (I6).
//
// This is the failing test of the issue (AGENTS.md): the first check fails on
// purpose until the model, the schema and the check land, so the test is
// marked as expected to fail. The mark comes off with the implementation.

const repo = join(import.meta.dirname, '..')

/** A canonical definition with one field of each of the sixteen controls (FM-1). */
const FILE = `{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "request",
      "targets": [
        {
          "starter": "starter"
        }
      ],
      "fields": [
        {
          "key": "summary",
          "control": "text"
        },
        {
          "key": "details",
          "control": "long-text"
        },
        {
          "key": "credits",
          "control": "number"
        },
        {
          "key": "fee",
          "control": "money"
        },
        {
          "key": "needed-by",
          "control": "date"
        },
        {
          "key": "advisor",
          "control": "select",
          "options": [
            "one",
            "two"
          ]
        },
        {
          "key": "topics",
          "control": "multi-select",
          "options": [
            "one",
            "two"
          ]
        },
        {
          "key": "urgent",
          "control": "checkbox"
        },
        {
          "key": "route",
          "control": "radio",
          "options": [
            "one",
            "two"
          ]
        },
        {
          "key": "approved",
          "control": "yes-no"
        },
        {
          "key": "contact",
          "control": "email"
        },
        {
          "key": "callback",
          "control": "phone"
        },
        {
          "key": "attachment",
          "control": "file"
        },
        {
          "key": "reviewer",
          "control": "user"
        },
        {
          "key": "notice",
          "control": "static"
        },
        {
          "key": "courses",
          "control": "repeating"
        }
      ]
    }
  ]
}
`

/** A value that a field of each control accepts (FM-1). */
const VALID: Record<ControlType, unknown> = {
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
  file: 'file:abc',
  user: 'user:okafor',
  static: undefined,
  repeating: [{ key: 'value' }],
}

/** Values that a field of each control refuses (FM-1). */
const INVALID: Record<ControlType, readonly unknown[]> = {
  text: [3, null],
  'long-text': [true],
  number: ['3', Number.NaN],
  money: ['12.50'],
  date: ['10/10/2026', '2026-1-1'],
  select: ['three', 1],
  'multi-select': [['three'], 'one'],
  checkbox: ['true'],
  radio: ['three'],
  'yes-no': ['maybe', true],
  email: ['not-an-email'],
  phone: ['not a phone'],
  file: [''],
  user: [''],
  static: ['text'],
  repeating: ['x', [1]],
}

/** One field of the control, with an option list for a choice control (FM-1). */
function fieldFor(control: ControlType): Field {
  const key = `f-${control}`
  if (control === 'select' || control === 'multi-select' || control === 'radio') {
    return { key, control, options: ['one', 'two'] }
  }
  return { key, control }
}

test.fails('#74 FM-1 the sixteen controls parse, round-trip and validate', () => {
  // (a) A definition that uses each of the sixteen controls parses, and the
  // canonical round trip reproduces the file byte for byte (I9). The fields
  // come back in order, one for each control.
  const definition = parse(FILE)
  expect(serialize(definition)).toBe(FILE)
  const fields = definition.steps[0]?.fields ?? []
  expect(fields.map((field) => field.control)).toEqual([...CONTROL_TYPES])

  // The canonical form carries the option list of a choice control and omits
  // it for the other controls (I9): parse then serialize is stable.
  expect(parse(serialize(definition))).toEqual(definition)
  expect(serialize(parse(serialize(definition)))).toBe(FILE)

  // (b) Submitted data for each control validates (FM-4): a value that fits
  // the control passes, and a value that does not fails with the path of the
  // field.
  for (const control of CONTROL_TYPES) {
    const field = fieldFor(control)
    expect(validateField(field, VALID[control]), `${control} accepts its value`).toBeUndefined()
    for (const value of INVALID[control]) {
      const error = validateField(field, value)
      expect(error, `${control} rejects ${JSON.stringify(value)}`).toBeDefined()
      expect(error?.path, 'the error names the field path').toBe(field.key)
    }
  }

  // The check is pure and deterministic (I6): the same field and value give
  // the same result on every call.
  const once = validateField(fieldFor('select'), 'three')
  expect(validateField(fieldFor('select'), 'three')).toEqual(once)

  // (c) The format refuses an unknown control and a malformed field (DF-1).
  const step = (fields: string): string =>
    `{ "schemaVersion": 1, "steps": [ { "key": "s", "targets": [ { "user": "user:sam" } ], "fields": ${fields} } ] }`
  expect(() => parse(step('[ { "key": "x", "control": "wysiwyg" } ]'))).toThrow(
    /not a control type/
  )
  expect(() => parse(step('"nope"'))).toThrow(/fields must be an array/)
  expect(() => parse(step('[ { "control": "text" } ]'))).toThrow(/field has no key/)
  expect(() => parse(step('[ { "key": "x", "control": "text", "options": [1] } ]'))).toThrow(
    /options must be an array of strings/
  )

  // (d) The published JSON Schema (DF-1) declares the optional fields, one
  // field shape and the sixteen controls, and keeps its objects closed.
  const schema = JSON.parse(readFileSync(join(repo, 'schemas', 'flow', 'v1.json'), 'utf8'))
  expect(schema.additionalProperties).toBe(false)
  expect(schema.$defs.step.additionalProperties).toBe(false)
  expect(schema.$defs.step.properties.fields).toEqual({
    description: 'The form fields that the step shows (FM-1).',
    type: 'array',
    items: { $ref: '#/$defs/field' },
  })
  expect(schema.$defs.field.required).toEqual(['key', 'control'])
  expect(schema.$defs.field.additionalProperties).toBe(false)
  expect(schema.$defs.control.enum).toEqual([...CONTROL_TYPES])
})
