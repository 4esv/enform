import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #53, STORIES.md Fuzzy paths: the eight variation operators over the
// S16 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#53 the Actor operator does each S16 step as each person of the cast (S16)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Lee, who approved, or Priya, who owns the flow with task.reassign, may
  // undo the approval (WF-5); nobody else may.
  const reached = variants
    .filter((v) => v.stepIndex === STEP.leeUndo && v.expected === 'reached')
    .map((v) => v.actor)
  expect(reached).toEqual(['user:priya', 'user:lee'])
})

test('#53 the Duplicate operator sends each S16 operation twice without changing the end state (S16)', async () => {
  await operators.duplicate()
})

test('#53 the Race operator adds a competing action at each S16 step: two undos (S16)', () => {
  // Every other person of the cast competes at each step; the worker's
  // record is nobody's of the cast, so all eight compete there.
  const competitors = golden.steps.reduce(
    (count, step) => count + PEOPLE.filter((person) => person !== step.actor).length,
    0
  )
  expect(operators.race()).toHaveLength(competitors)
})

test('#53 the Fault operator interrupts the S16 path at each step boundary (S16)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#53 the Offline operator does the S16 steps without a connection and reconnects (S16)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#53 the Clock operator moves the clock at each S16 step, near the undo period (S16)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#53 the Data operator generates valid and invalid data for each S16 field (S16)', async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#53 the Version operator publishes a new version at each S16 step boundary (S16)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
