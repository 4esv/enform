import { emptyState, type State } from '../../engine/apply.js'
import { createOperation } from '../../engine/operation.js'
import { oracles } from './oracles.js'
import type { Scenario } from './scenario.js'
import { startApi } from './server.js'

// Issue #24, STORIES.md Test method: the golden-path runner. In api mode each
// step is an HTTP request against the in-process server; the end state is the
// server's. Issue #28 runs the oracle pipeline over the end state: the
// invariants, the golden end state, then the timeline. A golden path is
// deterministic, so the runner never retries.

/** How many times to deliver each step's operation (same ID). */
export type Deliveries = (stepIndex: number) => number

// Execute a scenario in api mode, delivering each step's operation `deliveries(i)`
// times, and return the server's end state.
export async function runSteps(scenario: Scenario, deliveries: Deliveries): Promise<State> {
  const api = startApi(emptyState)
  const server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      const operation = createOperation(
        step.type,
        step.payload,
        { clock: () => i + 1, ids: () => `op-${i + 1}` },
        step.actor
      )
      for (let d = 0; d < deliveries(i); d += 1) {
        const response = await fetch(`http://127.0.0.1:${api.port()}/api/v1/operations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(operation),
        })
        if (response.status !== 201) {
          throw new Error(`step ${i + 1} delivery ${d + 1} failed: HTTP ${response.status}`)
        }
      }
    }
    return api.state()
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}

export async function runGolden(scenario: Scenario): Promise<void> {
  const state = await runSteps(scenario, () => 1)
  oracles(state, scenario)
}
