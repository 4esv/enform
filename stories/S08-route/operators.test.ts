import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { PEOPLE } from '../example-flow.js'
import { fields, golden, requires, STEP, versioning } from './scenario.js'

// Issue #45, STORIES.md Fuzzy paths: the eight variation operators over the
// S08 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#45 the Actor operator does each S08 step as each person of the cast (S08)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Lee and Jordan, the team's members when the task was routed, may
  // claim it (AS-4, I13); only Dana may change a team (AS-6).
  const claims = variants.filter((variant) => variant.stepIndex === STEP.leeClaim)
  expect(claims.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:lee',
    'user:jordan',
  ])
  const joins = variants.filter((variant) => variant.stepIndex === STEP.anaJoins)
  expect(joins.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:dana',
  ])
})

test('#45 the Duplicate operator sends each S08 operation twice without changing the end state (S08)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#45 the Race operator adds a competing action at each S08 step (S08)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#45 the Fault operator interrupts the S08 path at each step boundary (S08)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#45 the Offline operator does the S08 steps without a connection and reconnects (S08)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#45 the Clock operator moves the clock at each S08 step (S08)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#45 the Data operator generates valid and invalid data for each S08 field (S08)', {
  timeout: 120_000,
}, async () => {
  // A generated advisor of user:sam reroutes the advisor step to Sam (AS-1),
  // and an invalid value is refused with the field path (FM-4).
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
})

test('#45 the Version operator publishes a new version at each S08 step boundary (S08)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
