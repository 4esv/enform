import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #41, STORIES.md Fuzzy paths: the eight variation operators over the
// S04 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#41 the Actor operator does each S04 step as each person of the cast (S04)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Dana builds version 2 (DF-5), and only Sam's reopening rebinds his draft.
  const publishing = variants.filter((variant) => variant.stepIndex === STEP.publishV2)
  expect(
    publishing.filter((variant) => variant.expected === 'reached').map((v) => v.actor)
  ).toEqual(['user:dana'])
  const rebinding = variants.filter((variant) => variant.stepIndex === STEP.rebind)
  expect(rebinding.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual(
    ['user:sam']
  )
}, 120_000)

test('#41 the Duplicate operator sends each S04 operation twice without changing the end state (S04)', async () => {
  await operators.duplicate()
}, 120_000)

test('#41 the Race operator adds a competing action at each S04 step: an edit and a publish (S04)', () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#41 the Fault operator interrupts the S04 path at each step boundary (S04)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#41 the Offline operator does the S04 steps without a connection and reconnects (S04)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
}, 120_000)

test('#41 the Clock operator moves the clock at each S04 step (S04)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
}, 120_000)

test('#41 the Data operator generates valid and invalid data for each S04 field (S04)', async () => {
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
}, 120_000)

test('#41 the Version operator publishes a new version at each S04 step boundary (S04)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
}, 120_000)
