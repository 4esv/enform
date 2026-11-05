import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { PEOPLE } from '../example-flow.js'
import { fields, golden, requires, STEP, versioning } from './scenario.js'

// Issue #43, STORIES.md Fuzzy paths: the eight variation operators over the
// S06 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#43 the Actor operator does each S06 step as each person of the cast (S06)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only Sam, through the All-Students group, may start the flow (AC-1), and
  // only the starter may submit the draft (ADR 0014).
  for (const index of [STEP.start, STEP.submit]) {
    const reached = variants.filter((v) => v.stepIndex === index && v.expected === 'reached')
    expect(reached.map((variant) => variant.actor)).toEqual(['user:sam'])
  }
})

test('#43 the Duplicate operator sends each S06 operation twice without changing the end state (S06)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#43 the Race operator adds a competing action at each S06 step (S06)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#43 the Fault operator interrupts the S06 path at each step boundary (S06)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#43 the Offline operator does the S06 steps without a connection and reconnects (S06)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#43 the Clock operator moves the clock at each S06 step (S06)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#43 the Data operator generates valid and invalid data for each S06 field (S06)', {
  timeout: 120_000,
}, async () => {
  // The submit carries the form data (FM-4): a valid `urgent` of true makes
  // the triage step active, an invalid value is refused with the field path.
  const variants = await operators.data()
  expect(variants).toHaveLength(fields.length * 2)
})

test('#43 the Version operator publishes a new version at each S06 step boundary (S06)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
