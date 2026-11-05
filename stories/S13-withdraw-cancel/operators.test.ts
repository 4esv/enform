import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #50, STORIES.md Fuzzy paths: the eight variation operators over the
// S13 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#50 the Actor operator does each S13 step as each person of the cast (S13)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only the starter withdraws (AC-5), only Priya, who holds instance.cancel
  // through Dana's grant, cancels (AC-1), and only the closer undoes a close.
  const reached = (index: number) =>
    variants.filter((v) => v.stepIndex === index && v.expected === 'reached').map((v) => v.actor)
  expect(reached(STEP.withdraw)).toEqual(['user:sam'])
  expect(reached(STEP.cancel)).toEqual(['user:priya'])
  expect(reached(STEP.undoWithdraw)).toEqual(['user:sam'])
  expect(reached(STEP.undoCancel)).toEqual(['user:priya'])
})

test('#50 the Duplicate operator sends each S13 operation twice without changing the end state (S13)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#50 the Race operator adds a competing action at each S13 step: a withdraw and a cancel (S13)', {
  timeout: 120_000,
}, () => {
  expect(operators.race()).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#50 the Fault operator interrupts the S13 path at each step boundary (S13)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#50 the Offline operator does the S13 steps without a connection and reconnects (S13)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#50 the Clock operator moves the clock at each S13 step, near the undo period (S13)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#50 the Data operator generates valid and invalid data for each S13 field (S13)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#50 the Version operator publishes a new version at each S13 step boundary (S13)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
