import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #47, STORIES.md Fuzzy paths: the eight variation operators over the
// S10 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#47 the Actor operator does each S10 step as each person of the cast (S10)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // Only another assignee of the registrar step takes over from Lee (AS-3),
  // and only the previous holder, the taker or a flow owner undoes it (WF-5).
  const takeovers = variants.filter((variant) => variant.stepIndex === STEP.takeover)
  expect(takeovers.filter((v) => v.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:ana',
    'user:jordan',
  ])
  const undos = variants.filter((variant) => variant.stepIndex === STEP.undo)
  expect(undos.filter((v) => v.expected === 'reached').map((v) => v.actor)).toEqual([
    'user:priya',
    'user:lee',
    'user:ana',
  ])
})

test('#47 the Duplicate operator sends each S10 operation twice without changing the end state (S10)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#47 the Race operator adds a competing action at each S10 step: claim and takeover (S10)', {
  timeout: 120_000,
}, () => {
  const variants = operators.race()
  expect(variants).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#47 the Fault operator interrupts the S10 path at each step boundary (S10)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#47 the Offline operator does the S10 steps without a connection and reconnects (S10)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#47 the Clock operator moves the clock at each S10 step, near the idle limit (S10)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#47 the Data operator generates valid and invalid data for each S10 field (S10)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#47 the Version operator publishes a new version at each S10 step boundary (S10)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
