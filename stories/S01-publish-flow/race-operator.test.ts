import { expect, test } from 'vitest'
import { apply, emptyState } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { addGrant } from '../../engine/grants.js'
import type { Log } from '../../engine/operation.js'
import { castOf, raceVariants, runRaceOperator } from '../../tools/harness/operators.js'
import { golden } from './scenario.js'

// Issue #32, STORIES.md Fuzzy paths: the Race operator adds a competing action
// by another person at each step of a golden path. Both actions are based on
// the same version of the log, so the engine's optimistic version check (I5)
// accepts exactly one and refuses the other at once. The runner generates the
// variants from the golden path; no fuzzy test is written by hand.

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

test.fails('#32 the Race operator adds a competing action at each S01 step (S01)', () => {
  const people = castOf(grantsLog(cast))
  expect(Object.keys(people)).toHaveLength(8)

  // Dana acts every step of the golden path, so every other person is a
  // competitor. One variant per step and per competitor, generated in step
  // order, then cast order, so the generation is deterministic (I6).
  const competitors = Object.keys(people).filter((person) => person !== 'dana')
  const generated = raceVariants(golden, people)
  expect(generated).toHaveLength(golden.steps.length * competitors.length)
  expect(generated.slice(0, 2).map((variant) => variant.id)).toEqual([
    'race:step1:priya',
    'race:step1:sam',
  ])
  expect(generated.every((variant) => variant.actor === 'dana')).toBe(true)

  // The runner runs every race both ways: the golden action wins once and the
  // competitor wins once, and exactly one succeeds each time (I5). The oracles
  // check each winner's end state, so each run reaches its golden end state.
  const variants = runRaceOperator(golden, people)
  expect(variants).toHaveLength(golden.steps.length * competitors.length)
})
