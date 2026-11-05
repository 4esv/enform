import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #39, STORIES.md Fuzzy paths: the eight variation operators over the
// S02 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#39 the Actor operator does each S02 step as each person of the cast (S02)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Dana, who holds org.grants, grants and revokes (AC-1, I8).
  const granting = variants.filter(
    (variant) => variant.stepIndex === STEP.firstGrant || variant.stepIndex === STEP.revoke
  )
  expect(granting.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:dana',
    'user:dana',
  ])
  // Only Jordan, who holds the task, sends it back (AS-2, AC-4).
  const sendingBack = variants.filter((variant) => variant.stepIndex === STEP.jordanSendBack)
  expect(
    sendingBack.filter((variant) => variant.expected === 'reached').map((v) => v.actor)
  ).toEqual(['user:jordan'])
}, 120_000)

test('#39 the Duplicate operator sends each S02 operation twice without changing the end state (S02)', async () => {
  await operators.duplicate()
}, 120_000)

test('#39 the Race operator adds a competing action at each S02 step (S02)', () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#39 the Fault operator interrupts the S02 path at each step boundary (S02)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#39 the Offline operator does the S02 steps without a connection and reconnects (S02)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
}, 120_000)

test('#39 the Clock operator moves the clock at each S02 step (S02)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
}, 120_000)

test('#39 the Data operator generates valid and invalid data for each S02 field (S02)', async () => {
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
}, 120_000)

test('#39 the Version operator publishes a new version at each S02 step boundary (S02)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
}, 120_000)
