import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse, serialize } from '../engine/definition.js'

// Issue #170, DF-1, I9, MVP.md 9.3: definition schema version 2. The engine
// reads a v1 file and migrates it forward to v2, and reads and writes a v2
// file canonically. The v2 parts are sections, per-step visible and editable
// keys, rules, and the field defaults and connector-supplied values. The
// checks assert the canonical v2 bytes, the v1 to v2 migration rule, and that
// the published v2 JSON Schema agrees with the read path.

const repo = join(import.meta.dirname, '..')

/** A canonical v1 file: flat fields, outcomes and a skip condition. */
const V1_FILE = `{
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
          "key": "advisor",
          "control": "select",
          "options": [
            "one",
            "two"
          ]
        }
      ],
      "outcomes": [
        "approve",
        "send_back"
      ],
      "skipWhen": {
        "var": "skip_advisor"
      }
    }
  ]
}
`

/** The v2 file that the v1 file above migrates to: nothing changes but the version. */
const V1_MIGRATED_FILE = `{
  "schemaVersion": 2,
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
          "key": "advisor",
          "control": "select",
          "options": [
            "one",
            "two"
          ]
        }
      ],
      "outcomes": [
        "approve",
        "send_back"
      ],
      "skipWhen": {
        "var": "skip_advisor"
      }
    }
  ]
}
`

/** A canonical v2 file with sections, visibility, editability and one rule. */
const V2_FILE = `{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [
        {
          "starter": "starter"
        }
      ],
      "sections": [
        {
          "key": "details",
          "fields": [
            {
              "key": "summary",
              "control": "text",
              "required": true
            },
            {
              "key": "advisor",
              "control": "select",
              "options": [
                "one",
                "two"
              ],
              "optionsFrom": "list-advisors"
            }
          ],
          "collapsed": true
        }
      ],
      "visible": [
        "summary",
        "advisor"
      ],
      "editable": [
        "summary"
      ],
      "rules": [
        {
          "when": {
            "==": [
              {
                "var": "advisor"
              },
              "lin"
            ]
          },
          "effect": "show",
          "targets": [
            "section:details"
          ]
        }
      ]
    }
  ]
}
`

test('#170 a v1 file migrates to v2 with nothing added (DF-1, I9, 9.3)', () => {
  const migrated = parse(V1_FILE)
  expect(migrated.schemaVersion).toBe(2)
  // The migration is the whole rule: the only change is schemaVersion 2.
  expect(serialize(migrated)).toBe(V1_MIGRATED_FILE)
})

test('#170 a canonical v2 file round trips byte for byte (I9)', () => {
  const definition = parse(V2_FILE)
  expect(definition.schemaVersion).toBe(2)
  expect(serialize(definition)).toBe(V2_FILE)
})

test('#170 the v2 schema agrees with what the read path accepts and rejects (DF-1)', () => {
  const schema = JSON.parse(readFileSync(join(repo, 'schemas', 'flow', 'v2.json'), 'utf8'))

  // The published schema keeps its objects closed and pins the version to 2.
  expect(schema.additionalProperties).toBe(false)
  expect(schema.properties.schemaVersion).toEqual({ const: 2 })
  expect(schema.required).toEqual(['schemaVersion', 'steps'])
  expect(schema.$defs.step.additionalProperties).toBe(false)
  expect(schema.$defs.section.additionalProperties).toBe(false)
  expect(schema.$defs.section.required).toEqual(['key', 'fields'])
  expect(schema.$defs.field.additionalProperties).toBe(false)
  expect(schema.$defs.field.properties.required).toEqual({ type: 'boolean' })
  expect(schema.$defs.field.properties.key.not).toEqual({ const: 'context' })
  expect(schema.$defs.field.properties.default).toEqual({ $ref: '#/$defs/jsonLogic' })
  expect(schema.$defs.field.properties.optionsFrom).toEqual({
    description: 'The connector read operation that supplies the option list (FM-6).',
    type: 'string',
  })
  expect(schema.$defs.field.properties.valueFrom).toEqual({
    description: 'The connector read operation that supplies the default value (FM-6).',
    type: 'string',
  })
  expect(schema.$defs.rule.additionalProperties).toBe(false)
  expect(schema.$defs.rule.required).toEqual(['when', 'effect', 'targets'])
  expect(schema.$defs.rule.properties.when).toEqual({ $ref: '#/$defs/jsonLogic' })
  expect(schema.$defs.rule.properties.effect).toEqual({
    enum: ['show', 'hide', 'collapse', 'require', 'lock', 'skip'],
  })

  // The read path accepts the new parts and rejects documents the schema
  // forbids, with the ID that each rule enforces.
  const step = (body: string): string =>
    `{ "schemaVersion": 2, "steps": [ { "key": "s", "targets": [ { "user": "user:sam" } ], ${body} } ] }`

  expect(() =>
    parse(
      step(
        '"fields": [ { "key": "a", "control": "text" } ], "sections": [ { "key": "g", "fields": [ { "key": "b", "control": "text" } ] } ]'
      )
    )
  ).toThrow(/both fields and sections/)

  expect(() =>
    parse(step('"fields": [ { "key": "a", "control": "text" } ], "visible": [ "b" ]'))
  ).toThrow(/visible names a field/)
  expect(() =>
    parse(step('"fields": [ { "key": "a", "control": "text" } ], "editable": [ "b" ]'))
  ).toThrow(/editable names a field/)
  expect(() =>
    parse(step('"fields": [ { "key": "a", "control": "text", "required": "yes" } ]'))
  ).toThrow(/required must be a boolean/)
  expect(() =>
    parse(step('"fields": [ { "key": "a", "control": "text", "optionsFrom": 3 } ]'))
  ).toThrow(/optionsFrom must be a string/)
  expect(() =>
    parse(step('"fields": [ { "key": "a", "control": "text", "valueFrom": true } ]'))
  ).toThrow(/valueFrom must be a string/)
  expect(() =>
    parse(step('"rules": [ { "when": true, "effect": "explode", "targets": [] } ]'))
  ).toThrow(/not a rule effect/)
  expect(() =>
    parse(step('"rules": [ { "when": true, "effect": "show", "targets": [ "missing" ] } ]'))
  ).toThrow(/a rule targets a field or section the step does not have/)
  expect(() =>
    parse(step('"rules": [ { "when": true, "effect": "show", "targets": [ "section:g" ] } ]'))
  ).toThrow(/a rule targets a field or section the step does not have/)

  // A v1 document that v1 rejects is still rejected through the migrator.
  expect(() => parse('{ "schemaVersion": 1, "anonymous": "yes", "steps": [] }')).toThrow(
    /anonymous must be a boolean/
  )
})
