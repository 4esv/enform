import type { Scenario } from './scenario.js'

// Issue #24, STORIES.md Test method: the golden-path runner. Scaffolding: it
// throws until the api-mode execution lands in the implementation commit.

export async function runGolden(_scenario: Scenario): Promise<void> {
  throw new Error('the api-mode runner is not implemented (issue #24)')
}
