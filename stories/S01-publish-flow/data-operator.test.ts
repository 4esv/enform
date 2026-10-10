import { expect, test } from 'vitest'
import { CONTROL_TYPES, type Field, parse } from '../../engine/definition.js'
import { validateField } from '../../engine/fields.js'
import { dataVariants, runDataOperator } from '../../tools/harness/operators.js'
import { scenario } from '../../tools/harness/scenario.js'

// Issue #36, STORIES.md Fuzzy paths: the Data operator generates valid and
// invalid form data from the flow schema, with property-based generation. The
// S01 publish flow carries no form fields, so this check uses a small
// field-bearing flow fixture: one step with one field of each of the sixteen
// FM-1 controls, and a submission step that carries the form data (FM-4). For
// each field the operator generates a value that the control accepts and one
// that it refuses; the engine's validator (validateField, FM-4) is the oracle,
// so an accepted value reaches the golden state and a refused value deviates
// by the submission step, with the failure naming the field path (FM-1). The
// runner generates the variants; no fuzzy test is written by hand.

/** A flow with one field of each of the sixteen FM-1 controls, in control order. */
const definition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "request",
      "targets": [{ "user": "user:sam" }],
      "fields": [
        { "key": "summary", "control": "text" },
        { "key": "details", "control": "long-text" },
        { "key": "credits", "control": "number" },
        { "key": "fee", "control": "money" },
        { "key": "needed-by", "control": "date" },
        { "key": "advisor", "control": "select", "options": ["okafor", "lin"] },
        { "key": "topics", "control": "multi-select", "options": ["forms", "workflow"] },
        { "key": "urgent", "control": "checkbox" },
        { "key": "route", "control": "radio", "options": ["one", "two"] },
        { "key": "approved", "control": "yes-no" },
        { "key": "contact", "control": "email" },
        { "key": "callback", "control": "phone" },
        { "key": "attachment", "control": "file" },
        { "key": "reviewer", "control": "user" },
        { "key": "notice", "control": "static" },
        { "key": "courses", "control": "repeating" }
      ]
    }
  ]
}
`)

/** The form fields of the flow's steps, in step order (FM-1). */
const fields: readonly Field[] = definition.steps.flatMap((step) => step.fields ?? [])

/** The golden path: a definition change, then the submission that carries the form data (FM-4). */
const golden = scenario({
  slug: 'data-flow',
  steps: [
    { actor: 'sam', type: 'config.definition.changed@1', payload: definition },
    { actor: 'sam', type: 'instance.submitted@1', payload: { data: {} } },
  ],
})

test.fails('#36 the Data operator generates valid and invalid data per S01 field (S01)', async () => {
  // The fixture carries one field of each of the sixteen FM-1 controls, so the
  // generator covers every control type.
  expect(fields.map((field) => field.control)).toEqual([...CONTROL_TYPES])

  // One valid and one invalid variant per field, in field order, valid before
  // invalid, so the generation is deterministic (I6).
  const generated = dataVariants(golden, fields)
  expect(generated).toHaveLength(fields.length * 2)
  expect(generated.slice(0, 2).map((variant) => variant.id)).toEqual([
    'data:valid:summary',
    'data:invalid:summary',
  ])
  expect(generated.filter((variant) => variant.expected === 'accepted')).toHaveLength(fields.length)
  expect(generated.filter((variant) => variant.expected === 'refused')).toHaveLength(fields.length)

  // The engine's validator decides (FM-4): every valid value passes, and every
  // invalid value fails with the path of its field (FM-1).
  for (const variant of generated) {
    const error = validateField(variant.field, variant.value)
    if (variant.expected === 'accepted') {
      expect(error, `${variant.id} accepts its value`).toBeUndefined()
      expect(variant.deviation).toBeUndefined()
    } else {
      expect(error?.path, `${variant.id} names the field path`).toBe(variant.field.key)
      expect(variant.deviation?.path).toBe(variant.field.key)
    }
  }

  // The runner runs every variant, and the oracles check each run (STORIES.md,
  // Oracles): an accepted value reaches the golden state, and a refused value
  // deviates by the submission step.
  const variants = await runDataOperator(golden, fields)
  expect(variants).toHaveLength(fields.length * 2)
})
