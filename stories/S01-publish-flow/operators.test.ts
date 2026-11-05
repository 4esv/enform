import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #38, STORIES.md Fuzzy paths: the eight variation operators over the
// S01 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#38 the Actor operator does each S01 step as each person of the cast (S01)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Dana, who holds flow.build, pushes and publishes (DF-5, D2, I8).
  for (const index of [STEP.push, STEP.publish, STEP.change]) {
    const at = variants.filter((variant) => variant.stepIndex === index)
    expect(at.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
      'user:dana',
    ])
  }
})

test('#38 the Duplicate operator sends each S01 operation twice without changing the end state (S01)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#38 the Race operator adds a competing action at each S01 step (S01)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#38 the Fault operator interrupts the S01 path at each step boundary (S01)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#38 the Offline operator does the S01 steps without a connection and reconnects (S01)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#38 the Clock operator moves the clock at each S01 step (S01)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#38 the Data operator finds no form data to vary in S01, which captures no values (S01)', {
  timeout: 120_000,
}, async () => {
  // The operator says so instead of generating nothing silently (FM-4).
  await expect(operators.data()).rejects.toThrow(/no step that carries form data/)
})

test('#38 the Version operator publishes a version beside each S01 step and the instances it has stay on theirs (S01)', {
  timeout: 120_000,
}, async () => {
  await operators.version()
})
