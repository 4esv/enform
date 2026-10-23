import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CONTROL_TYPES, parse, serialize, takeoverIdleMs } from '../engine/definition.js'

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
              "label": "Summary",
              "required": true
            },
            {
              "key": "advisor",
              "control": "select",
              "label": "Advisor",
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

/** A canonical v2 file with the flow's undo period (S13, S16, WF-5). */
const V2_UNDO_FILE = `{
  "schemaVersion": 2,
  "undoHours": 24,
  "steps": [
    {
      "key": "request",
      "targets": [
        {
          "starter": "starter"
        }
      ]
    }
  ]
}
`

// Issue #238, S13, S16, WF-5, DF-1, I9: the flow sets the undo period, and the
// canonical form writes it after the anonymous setting and before the steps.
// An absent period is not written, and the v2 schema validates a present one as
// a positive integer.
test('#238 the flow undo period round trips through the canonical form (DF-1, I9)', () => {
  const once = parse(V2_UNDO_FILE)
  expect(once.undoHours).toBe(24)
  expect(serialize(once)).toBe(V2_UNDO_FILE)
  expect(parse(serialize(once)).undoHours).toBe(24)

  // An absent setting is absent, not 0: the server applies its own default.
  expect(parse(V2_FILE).undoHours).toBeUndefined()
  expect(serialize(parse(V2_FILE))).toBe(V2_FILE)

  const step = (body: string): string =>
    `{ "schemaVersion": 2, ${body} "steps": [ { "key": "s", "targets": [ { "user": "user:sam" } ] } ] }`
  expect(() => parse(step('"undoHours": 0,'))).toThrow(/positive integer/)
  expect(() => parse(step('"undoHours": 1.5,'))).toThrow(/positive integer/)
  expect(() => parse(step('"undoHours": "24",'))).toThrow(/positive integer/)

  const schema = JSON.parse(readFileSync(join(repo, 'schemas', 'flow', 'v2.json'), 'utf8'))
  expect(schema.properties.undoHours).toEqual({
    description:
      'How long after a withdrawal or a cancellation the closer may undo it, in hours (WF-5, S13, S16). Absent means the server default of 24 hours.',
    type: 'integer',
    minimum: 1,
  })
  expect(schema.required, 'the undo period is optional').toEqual(['schemaVersion', 'steps'])
})

/** A canonical v2 file with the registrar step's takeover setting (S10, AS-3). */
const V2_TAKEOVER_FILE = `{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "registrar",
      "targets": [
        {
          "team": "registrar-office"
        }
      ],
      "outcomes": [
        "approve"
      ],
      "takeover": "after-idle",
      "idleMinutes": 4
    }
  ]
}
`

// Issue #242, S10, AS-3, DF-1, I9: a step sets when an assignee may take over
// a claimed task. The canonical form writes the setting after the outcomes and
// the idle period after the setting; an absent setting is never written, and
// the v2 schema validates the setting and a positive idle period.
test('#242 the step takeover setting round trips through the canonical form (DF-1, I9)', () => {
  const firstStep = (definition: ReturnType<typeof parse>) => {
    const [first] = definition.steps
    if (first === undefined) throw new Error('the fixture has no step')
    return first
  }
  const once = parse(V2_TAKEOVER_FILE)
  expect(once.steps[0]?.takeover).toBe('after-idle')
  expect(once.steps[0]?.idleMinutes).toBe(4)
  expect(takeoverIdleMs(firstStep(once))).toBe(4 * 60_000)
  expect(serialize(once)).toBe(V2_TAKEOVER_FILE)
  expect(parse(serialize(once)).steps[0]?.takeover).toBe('after-idle')

  // An absent setting is absent, not `never`: the step opts in (AS-3).
  expect(parse(V2_FILE).steps[0]?.takeover).toBeUndefined()
  expect(takeoverIdleMs(firstStep(parse(V2_FILE)))).toBeUndefined()

  const step = (body: string): string =>
    `{ "schemaVersion": 2, "steps": [ { "key": "s", "targets": [ { "user": "user:sam" } ], ${body} } ] }`
  expect(() => parse(step('"takeover": "sometimes"'))).toThrow(/not a takeover setting/)
  expect(() => parse(step('"takeover": "after-idle", "idleMinutes": 0'))).toThrow(
    /positive integer/
  )
  expect(() => parse(step('"takeover": "after-idle", "idleMinutes": 1.5'))).toThrow(
    /positive integer/
  )
  expect(() => parse(step('"takeover": "after-idle", "idleMinutes": "4"'))).toThrow(
    /positive integer/
  )

  // `always` measures no idle period and `never` allows none (AS-3).
  const always = firstStep(parse(step('"takeover": "always"')))
  expect(takeoverIdleMs(always)).toBe(0)
  const never = firstStep(parse(step('"takeover": "never"')))
  expect(takeoverIdleMs(never)).toBeUndefined()
  // `after-idle` without an explicit period uses the 60 minute default (AS-3).
  const defaulted = firstStep(parse(step('"takeover": "after-idle"')))
  expect(takeoverIdleMs(defaulted)).toBe(60 * 60_000)

  const schema = JSON.parse(readFileSync(join(repo, 'schemas', 'flow', 'v2.json'), 'utf8'))
  expect(schema.$defs.step.properties.takeover).toEqual({
    description:
      'When an assignee may take over a claimed task (AS-3, S10): always at once, after-idle after idleMinutes since the claim, or never. Absent means never.',
    enum: ['always', 'after-idle', 'never'],
  })
  expect(schema.$defs.step.properties.idleMinutes).toEqual({
    description:
      'The idle period in minutes that after-idle waits before a takeover (AS-3, S10). Absent means 60 minutes.',
    type: 'integer',
    minimum: 1,
  })
})

/** A canonical v2 file with the advisor step's timers (S12, SE-3, SE-4). */
const V2_TIMERS_FILE = `{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "advisor",
      "targets": [
        {
          "user": "user:okafor"
        }
      ],
      "outcomes": [
        "approve",
        "send_back"
      ],
      "reminderMinutes": 30,
      "deadlineMinutes": 120,
      "escalationTargets": [
        {
          "team": "CS-Chairs"
        }
      ]
    }
  ]
}
`

// Issue #248, S12, SE-3, SE-4, DF-1, I9: a step sets the interval between its
// reminders and its deadline, and the targets that the escalation adds. The
// canonical form writes the interval and the deadline after the takeover
// settings, then the escalation targets before the skip condition. An absent
// setting is never written, and the v2 schema validates each as a positive
// integer or a target list.
test('#248 the step reminder and deadline settings round trip (S12, SE-3, SE-4, I9)', () => {
  const once = parse(V2_TIMERS_FILE)
  expect(once.steps[0]?.reminderMinutes).toBe(30)
  expect(once.steps[0]?.deadlineMinutes).toBe(120)
  expect(once.steps[0]?.escalationTargets).toEqual([{ team: 'CS-Chairs' }])
  expect(serialize(once)).toBe(V2_TIMERS_FILE)
  expect(parse(serialize(once)).steps[0]?.reminderMinutes).toBe(30)

  // An absent setting is absent, not 0: the step sets no timer (SE-3, SE-4).
  expect(parse(V2_FILE).steps[0]?.reminderMinutes).toBeUndefined()
  expect(parse(V2_FILE).steps[0]?.deadlineMinutes).toBeUndefined()
  expect(parse(V2_FILE).steps[0]?.escalationTargets).toBeUndefined()
  expect(serialize(parse(V2_FILE))).toBe(V2_FILE)

  const step = (body: string): string =>
    `{ "schemaVersion": 2, "steps": [ { "key": "s", "targets": [ { "user": "user:sam" } ], ${body} } ] }`
  expect(() => parse(step('"reminderMinutes": 0'))).toThrow(/positive integer/)
  expect(() => parse(step('"reminderMinutes": 1.5'))).toThrow(/positive integer/)
  expect(() => parse(step('"reminderMinutes": "30"'))).toThrow(/positive integer/)
  expect(() => parse(step('"deadlineMinutes": 0'))).toThrow(/positive integer/)
  expect(() => parse(step('"deadlineMinutes": "120"'))).toThrow(/positive integer/)
  expect(() => parse(step('"escalationTargets": "CS-Chairs"'))).toThrow(/must be an array/)
  expect(() => parse(step('"escalationTargets": [ { "team": 4 } ]'))).toThrow(
    /target value must be a string/
  )

  const schema = JSON.parse(readFileSync(join(repo, 'schemas', 'flow', 'v2.json'), 'utf8'))
  expect(schema.$defs.step.properties.reminderMinutes).toEqual({
    description:
      'The interval between two reminders, in minutes (SE-3, S12). Absent means the step sends no reminder.',
    type: 'integer',
    minimum: 1,
  })
  expect(schema.$defs.step.properties.deadlineMinutes).toEqual({
    description:
      "The deadline from the task's start, in minutes (SE-4, S12). Absent means the step has no deadline and no escalation; the reminders stop at the deadline.",
    type: 'integer',
    minimum: 1,
  })
  expect(schema.$defs.step.properties.escalationTargets).toEqual({
    description:
      'The targets that the escalation adds at the deadline (SE-4, S12). The escalation notifies a person and never removes the current owner.',
    type: 'array',
    items: { $ref: '#/$defs/target' },
  })
})

// Issue #230, DF-1, FM-1, I9: the field label is part of the definition
// contract. The parser reads it, the canonical form writes it after the
// control, and a second parse sees the same label and the same bytes.
test('#230 a field label round trips through the canonical form (DF-1, FM-1, I9)', () => {
  const once = parse(V2_FILE)
  const bytes = serialize(once)
  const twice = parse(bytes)
  const fields = twice.steps[0]?.sections?.[0]?.fields ?? []
  expect(fields.map((field) => field.label)).toEqual(['Summary', 'Advisor'])
  expect(serialize(twice)).toBe(V2_FILE)
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
  expect(schema.$defs.field.required).toEqual(['key', 'control'])
  expect(schema.$defs.field.additionalProperties).toBe(false)
  expect(schema.$defs.control.enum).toEqual([...CONTROL_TYPES])
  expect(schema.$defs.field.properties.key.not).toEqual({ const: 'context' })
  expect(schema.$defs.field.properties.label).toEqual({
    description:
      'The human label the form shows for the field (FM-1). Absent means the form shows the key.',
    type: 'string',
    minLength: 1,
  })
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
  expect(() => parse(step('"fields": [ { "key": "a", "control": "text", "label": "" } ]'))).toThrow(
    /label must be a non-empty string/
  )
  expect(() => parse(step('"fields": [ { "key": "a", "control": "text", "label": 3 } ]'))).toThrow(
    /label must be a non-empty string/
  )
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
