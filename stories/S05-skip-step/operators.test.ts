import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #42, STORIES.md Fuzzy paths: the eight variation operators over the
// S05 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#42 the Actor operator does each S05 step as each person of the cast (S05)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Dr. Lin, through the CS-Chairs group, may claim the chair task (AS-4).
  const claims = variants.filter((variant) => variant.stepIndex === STEP.linClaim)
  expect(claims.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:lin',
  ])
})

test('#42 the Duplicate operator sends each S05 operation twice without changing the end state (S05)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#42 the Race operator adds a competing action at each S05 step (S05)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#42 the Fault operator interrupts the S05 path at each step boundary (S05)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#42 the Offline operator does the S05 steps without a connection and reconnects (S05)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#42 the Clock operator moves the clock at each S05 step (S05)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#42 the Data operator generates valid and invalid data for each S05 field (S05)', {
  timeout: 120_000,
}, async () => {
  // The data step is the first submit, the two-credit request: a generated
  // overload_credits of 1 still skips the chair (FM-1, WF-1).
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
})

test('#42 the Version operator publishes a new version at each S05 step boundary (S05)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
