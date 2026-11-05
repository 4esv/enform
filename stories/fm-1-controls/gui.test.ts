import { expect, test } from 'vitest'
import type { Field } from '../../engine/definition.js'
import { validateField } from '../../engine/fields.js'
import { instanceOf } from '../../engine/instances.js'
import { runSteps } from '../../tools/harness/runner.js'
import { definitionV2, flowState, golden, INSTANCE_ID, values } from './scenario.js'

// Issue #106, FM-1, FM-3, FM-7, A9, I12, ADR 0009: the requirement test for
// FM-1. No story cites FM-1, so MVP.md section 13 (the #99 entry) makes a
// requirement test its evidence. The browser opens the form, renders one
// control for each of the sixteen controls and fills every control. The page
// is local first (RT-3, #262): the first change starts the draft and each
// later change is one draft edit, and gui mode requires every appended event
// to equal the engine step at the same index (I6), so the draft's values are
// exactly the values that the browser collected (FM-7).
//
// The validator below is the same validateField that a submit runs, so the
// test states the contract the values must meet: the server accepts what the
// browser collects (FM-3, FM-4, A9).

test('#106 FM-1 the browser renders the sixteen controls and submits values the server accepts', async () => {
  const gui = await runSteps(golden, { mode: 'gui', seed: flowState() })
  expect(gui.state.log[0]?.type).toBe('instance.started@1')
  // The projection reads the instance against its published definition, so
  // the seed's publication precedes the page's events.
  const log = [...flowState().log, ...gui.state.log]
  expect(instanceOf(log, INSTANCE_ID)?.values).toEqual(values)
  // Every field of the step accepts the value the browser collected, through
  // the same validator that a submit runs (FM-4).
  const fields = definitionV2.steps[0]?.fields ?? []
  expect(fields).toHaveLength(16)
  for (const field of fields as readonly Field[]) {
    expect(
      validateField(field, values[field.key]),
      `${field.key} accepts its value`
    ).toBeUndefined()
  }
}, 120_000)
