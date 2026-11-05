import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #44, STORIES.md Fuzzy paths: the eight variation operators over the
// S07 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles). The cli mode is skipped for this
// story (STORIES.md, S07 Modes): the operators run in api mode.

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#44 the Actor operator does each S07 step as each person of the cast (S07)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only the starter edits and submits his draft (ADR 0014, D1).
  for (const index of [STEP.firstEdit, STEP.submit]) {
    const reached = variants.filter((v) => v.stepIndex === index && v.expected === 'reached')
    expect(reached.map((variant) => variant.actor)).toEqual(['user:sam'])
  }
})

test('#44 the Duplicate operator sends each S07 operation twice without changing the end state (S07)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#44 the Race operator adds a competing action at each S07 step (S07)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#44 the Fault operator interrupts the S07 path at each step boundary (S07)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#44 the Offline operator does the S07 steps without a connection and reconnects (S07)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#44 the Clock operator moves the clock at each S07 step (S07)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#44 the Data operator generates valid and invalid data for each S07 field (S07)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
})

test('#44 the Version operator publishes a new version at each S07 step boundary (S07)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
