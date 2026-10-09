import { oracles } from './oracles.js'
import { type Deliveries, runSteps } from './runner.js'
import type { Scenario } from './scenario.js'

// Issue #31, STORIES.md Fuzzy paths: variation operators generate fuzzy paths
// from a golden path. Duplicate sends each operation two times; the end state
// does not change (I1, I3).

export type Operator = {
  readonly id: string
  /** How many times to deliver each step's operation (same ID). */
  readonly deliveries: Deliveries
}

/** Duplicate: send each operation two times. The second send is a no-op (I1). */
export const DUPLICATE: Operator = { id: 'Duplicate', deliveries: () => 2 }

/** Run one fuzzy path of a golden path, then check it against the oracles. */
export async function runOperator(scenario: Scenario, operator: Operator): Promise<void> {
  const { state } = await runSteps(scenario, { mode: 'api', deliveries: operator.deliveries })
  oracles(state, scenario)
}
