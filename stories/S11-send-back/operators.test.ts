import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #48, STORIES.md Fuzzy paths: the eight variation operators over the
// S11 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#48 the Actor operator does each S11 step as each person of the cast (S11)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only the holder with step.outcome:send_back sends a step back (AC-4):
  // Dr. Okafor at the advisor step, Jordan at the registrar step.
  const first = variants.filter((variant) => variant.stepIndex === STEP.okaforSendBack)
  expect(first.filter((v) => v.expected === 'reached').map((v) => v.actor)).toEqual(['user:okafor'])
  const second = variants.filter((variant) => variant.stepIndex === STEP.jordanSendBack)
  expect(second.filter((v) => v.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:jordan',
  ])
})

test('#48 the Duplicate operator sends each S11 operation twice without changing the end state (S11)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#48 the Race operator adds a competing action at each S11 step (S11)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#48 the Fault operator interrupts the S11 path at each step boundary (S11)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#48 the Offline operator does the S11 steps without a connection and reconnects (S11)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#48 the Clock operator moves the clock at each S11 step (S11)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#48 the Data operator generates valid and invalid data for each S11 field (S11)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#48 the Version operator publishes a new version at each S11 step boundary (S11)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
