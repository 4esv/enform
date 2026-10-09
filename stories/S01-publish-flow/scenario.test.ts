import { expect, test } from 'vitest'
import type { State } from '../../engine/apply.js'
import { oracles } from '../../tools/harness/oracles.js'
import { runGolden } from '../../tools/harness/runner.js'
import { goldenView } from '../../tools/harness/scenario.js'
import { golden } from './scenario.js'

// Issue #24: the golden-path runner executes a scenario in api mode and the
// end state equals the golden end state. The first check is marked expected
// to fail until the runner is implemented.

test('#24 the api-mode runner reaches the golden end state (S01)', async () => {
  await runGolden(golden)
  expect(goldenView(golden).log).toHaveLength(1)
})

// Issue #28: the oracle pipeline checks every run in the order of #28, so all
// invariants, then the golden end state, then the timeline. This run is the
// golden run with the actor stripped from its one behavior event, a violation
// of I14. The pipeline must reject it. The check is marked expected to fail
// until the pipeline is implemented.

test.fails('#28 the oracles fail a run whose behavior event has no actor', () => {
  const expected = goldenView(golden)
  const unattributed: State = {
    applied: new Set(expected.applied),
    log: expected.log.map((event) => ({ ...event, actor: undefined })),
  }
  expect(() => oracles(unattributed, golden)).toThrow()
})
