import { expect, test } from 'vitest'
import type { Field } from '../../engine/definition.js'
import { validateField } from '../../engine/fields.js'
import { runSteps } from '../../tools/harness/runner.js'
import { definitionV2, flowState, golden, resolve, samGrants, values } from './scenario.js'

// Issue #106, FM-1, FM-3, FM-7, A9, I12, ADR 0009: the requirement test for
// FM-1. No story cites FM-1, so MVP.md section 13 (the #99 entry) makes a
// requirement test its evidence. The browser opens the form, renders one
// control for each of the sixteen controls, fills every control, and submits.
// gui mode appends exactly one event and requires it to equal the engine step
// at the same index (I6), so the values in the appended instance.started@1
// payload are exactly the values that the browser collected (FM-7).
//
// The start path does not validate today (#202 owns the start). The validator
// below is the same validateField that a completion runs, so the test states
// the contract the values must meet: the server accepts what the browser
// collects (FM-3, FM-4, A9).

test('#106 FM-1 the browser renders the sixteen controls and submits values the server accepts', async () => {
  const gui = await runSteps(golden, {
    mode: 'gui',
    resolve,
    grants: samGrants,
    seed: flowState(),
  })

  const started = gui.state.log[0]
  expect(started?.type).toBe('instance.started@1')
  expect(started?.payload.values).toEqual(values)

  // Every field of the step accepts the value the browser collected, through
  // the same validator that a completion runs (FM-4); the start that #202 owns
  // will run it on this path too.
  const fields = definitionV2.steps[0]?.fields ?? []
  expect(fields).toHaveLength(16)
  for (const field of fields as readonly Field[]) {
    expect(
      validateField(field, values[field.key]),
      `${field.key} accepts its value`
    ).toBeUndefined()
  }
}, 30_000)
