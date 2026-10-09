import { expect, test } from 'vitest'
import { goldenView } from '../../tools/harness/scenario.js'
import { runGolden } from '../../tools/harness/runner.js'
import { golden } from './scenario.js'

// Issue #24: the golden-path runner executes a scenario in api mode and the
// end state equals the golden end state. The first check is marked expected
// to fail until the runner is implemented.

test.fails('#24 the api-mode runner reaches the golden end state (S01)', async () => {
  await runGolden(golden)
  expect(goldenView(golden).log).toHaveLength(1)
})
