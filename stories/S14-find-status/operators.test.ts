import { expect, test } from 'vitest'
import { storyOperators } from '../../tools/harness/suite.js'
import { fields, PEOPLE, versioning } from '../example-flow.js'
import { golden, requires, STEP } from './scenario.js'

// Issue #51, STORIES.md Fuzzy paths: the eight variation operators over the
// S14 golden path. The runner generates every variant from the golden path;
// no fuzzy test is written by hand. Each operator's run checks every variant
// against the oracles: the invariants, the end state the engine predicts,
// and the timeline (STORIES.md, Oracles).

const operators = storyOperators({ golden, people: PEOPLE, requires, fields, versioning })

test('#51 the Actor operator does each S14 step as each person of the cast (S14)', {
  timeout: 120_000,
}, async () => {
  const variants = await operators.actor()
  expect(variants).toHaveLength(golden.steps.length * PEOPLE.length)
  // The holder or Priya, with task.reassign, releases (WF-5); Jordan alone
  // holds step.outcome:send_back on the registrar step (AC-4, S02).
  const reached = (index: number) =>
    variants.filter((v) => v.stepIndex === index && v.expected === 'reached').map((v) => v.actor)
  expect(reached(STEP.anaRelease)).toEqual(['user:priya', 'user:ana'])
  expect(reached(STEP.jordanSendBack)).toEqual(['user:jordan'])
})

test('#51 the Duplicate operator sends each S14 operation twice without changing the end state (S14)', {
  timeout: 120_000,
}, async () => {
  await operators.duplicate()
})

test('#51 the Race operator adds a competing action at each S14 step: two claims (S14)', {
  timeout: 120_000,
}, () => {
  expect(operators.race()).toHaveLength(golden.steps.length * (PEOPLE.length - 1))
})

test('#51 the Fault operator interrupts the S14 path at each step boundary (S14)', {
  timeout: 120_000,
}, () => {
  expect(operators.fault()).toHaveLength(golden.steps.length)
})

test('#51 the Offline operator does the S14 steps without a connection and reconnects (S14)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.offline()).toHaveLength(golden.steps.length)
})

test('#51 the Clock operator moves the clock at each S14 step (S14)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.clock()).toHaveLength(golden.steps.length * 3)
})

test('#51 the Data operator generates valid and invalid data for each S14 field (S14)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.data()).toHaveLength(fields.length * 2)
})

test('#51 the Version operator publishes a new version at each S14 step boundary (S14)', {
  timeout: 120_000,
}, async () => {
  expect(await operators.version()).toHaveLength(golden.steps.length)
})
