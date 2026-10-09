import type { Scenario } from './scenario.js'

// Issue #31, STORIES.md Fuzzy paths: variation operators generate fuzzy paths
// from a golden path. Duplicate sends each operation two times; the end state
// does not change (I1, I3). Scaffolding: the operator throws until the
// delivery logic lands in the implementation commit.

export type Operator = {
  readonly id: string
}

export const DUPLICATE: Operator = { id: 'Duplicate' }

export async function runOperator(_scenario: Scenario, _operator: Operator): Promise<void> {
  throw new Error('the Duplicate operator is not implemented (issue #31)')
}
