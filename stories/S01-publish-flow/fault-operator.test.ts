import { expect, test } from 'vitest'
import { faultVariants, runFaultOperator } from '../../tools/harness/operators.js'
import { golden } from './scenario.js'

// Issue #33, STORIES.md Fuzzy paths: the Fault operator interrupts a golden
// path at each step boundary: it restarts the server, stops the realtime
// connection and stops the worker (STORIES.md, Fuzzy paths). There is no
// realtime and no worker yet, so the fault is modelled at the engine boundary:
// the runner rebuilds the state from the log so far (I4), re-applies the
// operations (I1) and redelivers the side effects (I3), then continues the
// golden path. The engine is fault tolerant by construction, so every run
// reaches the golden end state. The runner generates the variants from the
// golden path; no fuzzy test is written by hand.

test('#33 the Fault operator survives an interruption at each S01 step (S01)', () => {
  // One variant per step boundary, in step order, so the generation is
  // deterministic (I6).
  const generated = faultVariants(golden)
  expect(generated).toHaveLength(golden.steps.length)
  expect(generated.map((variant) => variant.id)).toEqual([
    'fault:after-step1',
    'fault:after-step2',
    'fault:after-step3',
  ])

  // The runner faults at every boundary, and the oracles check each run: the
  // end state equals the golden end state, and I1, I2, I3 and I4 hold.
  const variants = runFaultOperator(golden)
  expect(variants).toHaveLength(golden.steps.length)
})
