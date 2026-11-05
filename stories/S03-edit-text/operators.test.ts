import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #40, STORIES.md Fuzzy paths: the eight variation operators over the
// S03 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#40 the Actor operator does each S03 step as each person of the cast (S03)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Priya edits with flow.edit, Dana with flow.build, and nobody else (DF-5, D2).
  const editing = variants.filter((variant) => variant.stepIndex === STEP.priyaPush)
  expect(editing.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:dana',
    'user:priya',
  ])
}, 120_000)

test('#40 the Duplicate operator sends each S03 operation twice without changing the end state (S03)', async () => {
  await operators.duplicate()
}, 120_000)

test('#40 the Race operator adds a competing action at each S03 step: an edit and a publish (S03)', () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#40 the Fault operator interrupts the S03 path at each step boundary (S03)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#40 the Offline operator does the S03 steps without a connection and reconnects (S03)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
}, 120_000)

test('#40 the Clock operator moves the clock at each S03 step (S03)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
}, 120_000)

test('#40 the Data operator generates valid and invalid data for each S03 field (S03)', async () => {
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
}, 120_000)

test('#40 the Version operator publishes a new version at each S03 step boundary (S03)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
}, 120_000)
