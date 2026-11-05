import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #52, STORIES.md Fuzzy paths: the eight variation operators over the
// S15 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#52 the Actor operator does each S15 step as each person of the cast (S15)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Dana grants and maintains a team (AC-2, AS-6).
  const reached = (index: number) =>
    variants.filter((v) => v.stepIndex === index && v.expected === 'reached').map((v) => v.actor)
  expect(reached(STEP.grantLee)).toEqual(['user:dana'])
  expect(reached(STEP.removeJordan)).toEqual(['user:dana'])
})

test('#52 the Duplicate operator sends each S15 operation twice without changing the end state (S15)', async () => {
  await operators.duplicate()
})

test('#52 the Race operator adds a competing action at each S15 step: an edit and a publish (S15)', () => {
  expect(operators.race()).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#52 the Fault operator interrupts the S15 path at each step boundary (S15)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#52 the Offline operator does the S15 steps without a connection and reconnects (S15)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#52 the Clock operator moves the clock at each S15 step (S15)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#52 the Data operator generates valid and invalid data for each S15 field (S15)', async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#52 the Version operator publishes a new version at each S15 step boundary (S15)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
