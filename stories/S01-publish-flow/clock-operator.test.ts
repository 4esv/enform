import { expect, test } from 'vitest'
import { clockVariants, runClockOperator } from '../../tools/harness/operators.js'
import { goldenClock } from '../../tools/harness/scenario.js'
import { golden } from './scenario.js'

// Issue #35, STORIES.md Fuzzy paths: the Clock operator moves the injected
// clock forward, back, or skews it at each step of a golden path, near
// deadlines and idle limits. The engine reads no clock of its own (I6), so a
// moved clock changes the `at` of the operations and nothing else: the same
// steps give the same state, and the timeline's `at` values follow the
// injected clock. The runner generates the variants from the golden path; no
// fuzzy test is written by hand.

test.fails('#35 the Clock operator moves the clock at each S01 step (S01)', async () => {
  // One variant per step and per move, generated in step order, then move
  // order, so the generation is deterministic (I6).
  const generated = clockVariants(golden)
  expect(generated).toHaveLength(golden.steps.length * 3)
  expect(generated.map((variant) => variant.id)).toEqual([
    'clock:forward:step1',
    'clock:back:step1',
    'clock:skew:step1',
    'clock:forward:step2',
    'clock:back:step2',
    'clock:skew:step2',
    'clock:forward:step3',
    'clock:back:step3',
    'clock:skew:step3',
  ])

  // Every variant moves the clock at its step, and leaves the earlier steps on
  // the golden step clock (I6).
  for (const variant of generated) {
    expect(variant.clock(variant.stepIndex)).not.toBe(goldenClock(variant.stepIndex))
    if (variant.stepIndex > 0) expect(variant.clock(0)).toBe(goldenClock(0))
  }

  // The runner runs every variant under its moved clock, and the oracles check
  // each run: the end state equals the golden state (the clock moves only
  // `at`), and the timeline's `at` values are the injected clock's readings.
  const variants = await runClockOperator(golden)
  expect(variants).toHaveLength(golden.steps.length * 3)
})
