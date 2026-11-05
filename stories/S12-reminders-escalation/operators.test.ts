import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE } from '../example-flow.js'
import { golden, requires, STEP, versioning } from './scenario.js'

// Issue #49, STORIES.md Fuzzy paths: the eight variation operators over the
// S12 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#49 the Actor operator does each S12 step as each person of the cast (S12)', async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // A timer firing is the worker's: no person of the cast does it (I14).
  const firings = variants.filter((variant) => variant.stepIndex === STEP.escalation)
  expect(firings.every((variant) => variant.expected === 'refused')).toBe(true)
})

test('#49 the Duplicate operator sends each S12 operation twice: each timer fires once (S12, I3)', async () => {
  await operators.duplicate()
})

test('#49 the Race operator adds a competing action at each S12 step (S12)', () => {
  const variants = operators.race()
  // Every other person of the cast competes at each step; at a timer firing
  // the worker acts, so every person of the cast competes.
  const competitors = golden.steps.reduce(
    (count, step) => count + PEOPLE.length - (PEOPLE.includes(step.actor) ? 1 : 0),
    0
  )
  expect(variants).toHaveLength(competitors)
})

test('#49 the Fault operator stops and restarts the worker at each S12 step boundary (S12, I3)', () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#49 the Offline operator does the S12 steps without a connection and reconnects (S12)', async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#49 the Clock operator moves the clock at each S12 step, near the deadline (S12)', async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#49 the Data operator generates valid and invalid data for each S12 field (S12)', async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#49 the Version operator publishes a new version at each S12 step boundary (S12)', async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
