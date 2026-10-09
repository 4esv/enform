import type { State } from '../../engine/apply.js'
import type { Scenario } from './scenario.js'

// Issue #28, STORIES.md Test method: the oracle pipeline that every run,
// golden or generated, passes through in this order: (1) all invariants are
// true, (2) the end state is the golden end state, (3) the timeline is
// consistent. Scaffolding: the registry and the three checks land in the
// implementation commit.

/** One end state that a run produced, and the scenario that the run followed. */
export type RunResult = {
  readonly state: State
  readonly scenario: Scenario
}

/** One invariant oracle (I1 to I16). A later milestone adds a new entry to the registry. */
export type InvariantOracle = {
  readonly id: string
  readonly check: (run: RunResult) => void
}

/**
 * The registered invariant oracles. A later milestone adds an invariant
 * without a change to the runner: it appends one entry here.
 */
export const INVARIANT_ORACLES: readonly InvariantOracle[] = []

/** Run the three checks of #28 in order over a finished run, and throw on the first failure. */
export function oracles(state: State, scenario: Scenario): void {
  assertInvariants({ state, scenario })
  assertGoldenEndState(state, scenario)
  assertTimeline(state)
}

/** Check 1: all registered invariants are true. */
function assertInvariants(run: RunResult): void {
  for (const oracle of INVARIANT_ORACLES) oracle.check(run)
}

/** Check 2: the end state is the golden end state. */
function assertGoldenEndState(_state: State, _scenario: Scenario): void {}

/** Check 3: the timeline is one global order, and every event is attributed. */
function assertTimeline(_state: State): void {}
