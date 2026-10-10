import { expect, test } from 'vitest'
import { apply, emptyState } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { addGrant } from '../../engine/grants.js'
import type { Log } from '../../engine/operation.js'
import {
  actorVariants,
  castOf,
  type Requirements,
  runActorOperator,
} from '../../tools/harness/operators.js'
import { golden } from './scenario.js'

// Issue #30, STORIES.md Fuzzy paths: the Actor operator does every step of a
// golden path as every person in the cast. The expected result comes from the
// grants of that person (I8): the engine's `authorize` reaches the golden end
// state, or refuses the step and the end state is the golden path without it.
// The runner generates the variants from the golden path; no fuzzy test is
// written by hand.

/** The flow of S01: Dana builds `course-overload` (S01 scenario). */
const FLOW = 'flow:course-overload'

/** The scope of every S01 step: the first draft and each structural change need `flow.build` (DF-5, D2). */
const BUILD = 'flow.build'

/**
 * The cast of S01 (STORIES.md, Cast). Dana builds every flow, so she holds
 * `flow.build` on all of them. Priya may edit the flow but not build it. The
 * others hold a start scope or one step's outcome scopes, not `flow.build`.
 */
const cast: readonly Grant[] = [
  { principal: 'dana', scopes: [BUILD], resource: '*' },
  { principal: 'priya', scopes: ['flow.edit', 'flow.dryrun', 'instance.read'], resource: FLOW },
  { principal: 'sam', scopes: ['instance.start'], resource: FLOW },
  {
    principal: 'okafor',
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: `${FLOW}/step:advisor`,
  },
  {
    principal: 'lin',
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: `${FLOW}/step:chair`,
  },
  {
    principal: 'lee',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: `${FLOW}/step:registrar`,
  },
  {
    principal: 'ana',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: `${FLOW}/step:registrar`,
  },
  { principal: 'jordan', scopes: ['step.outcome:send_back'], resource: `${FLOW}/step:registrar` },
]

/** The grants as they enter the log, one attributed operation each (AC-2, I14). */
function grantsLog(grants: readonly Grant[]): Log {
  let state = emptyState
  grants.forEach((grant, index) => {
    const deps = { clock: () => index + 1, ids: () => `grant-${index + 1}` }
    state = apply(addGrant(grant, 'dana', deps), state)
  })
  return state.log
}

/** Every S01 step requires `flow.build` on the flow (DF-5, D2). */
const requires: Requirements = () => ({ scope: BUILD, resource: FLOW })

test('#30 the Actor operator does each S01 step as each person of the cast (S01)', async () => {
  const people = castOf(grantsLog(cast))
  expect(Object.keys(people)).toHaveLength(8)

  // One variant per step and per person, generated in step order, then cast
  // order, so the generation is deterministic (I6).
  const generated = actorVariants(golden, people, requires)
  expect(generated).toHaveLength(golden.steps.length * 8)
  expect(generated.slice(0, 2).map((variant) => variant.id)).toEqual([
    'actor:step1:dana',
    'actor:step2:dana',
  ])

  // The runner runs every variant, and the oracles check each one.
  const variants = await runActorOperator(golden, people, requires)

  // AC-1: the engine's `authorize` decides from the person's grants. Dana
  // reaches the golden end state at every step; the other seven are refused.
  expect(variants.filter((variant) => variant.expected === 'reached')).toHaveLength(3)
  expect(variants.filter((variant) => variant.expected === 'refused')).toHaveLength(21)
  expect(
    variants.every((variant) => (variant.actor === 'dana') === (variant.expected === 'reached'))
  ).toBe(true)
})
