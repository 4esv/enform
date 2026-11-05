import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires } from './scenario.js'

// Issue #46, STORIES.md Fuzzy paths: the eight variation operators over the
// S09 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#46 the Actor operator does each S09 step as each person of the cast (S09)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Lee, Ana and Jordan may claim the registrar task (AS-4, AS-2), and
  // only Lee, who holds it, may approve it (AC-4).
  const claims = variants.filter((variant) => variant.stepIndex === 10)
  expect(claims.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:lee',
    'user:ana',
    'user:jordan',
  ])
  const approvals = variants.filter((variant) => variant.stepIndex === 11)
  expect(approvals.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual(
    ['user:lee']
  )
}, 120_000)

test('#46 the Duplicate operator sends each S09 operation twice without changing the end state (S09)', async () => {
  await operators.duplicate()
}, 120_000)

test('#46 the Race operator adds a competing action at each S09 step: two claims (S09)', () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
}, 120_000)

test('#46 the Fault operator interrupts the S09 path at each step boundary (S09)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
}, 120_000)

test('#46 the Offline operator does the S09 steps without a connection and reconnects (S09)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
}, 120_000)

test('#46 the Clock operator moves the clock at each S09 step (S09)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
}, 120_000)

test('#46 the Data operator generates valid and invalid data for each S09 field (S09)', async () => {
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
}, 120_000)

test('#46 the Version operator publishes a new version at each S09 step boundary (S09)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
}, 120_000)
