import { emptyState } from '../../engine/apply.js'
import { createOperation } from '../../engine/operation.js'
import { goldenView, type Scenario, toView } from './scenario.js'
import { startApi } from './server.js'

// Issue #24, STORIES.md Test method: the golden-path runner. In api mode each
// step is an HTTP request against the in-process server; the end state is the
// server's, compared to the deterministic engine replay (I6). A golden path
// is deterministic, so the runner never retries.

export async function runGolden(scenario: Scenario): Promise<void> {
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
      const response = await fetch(`http://127.0.0.1:${api.port()}/api/v1/operations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(operation),
      })
      if (response.status !== 201) throw new Error(`step ${i + 1} failed: HTTP ${response.status}`)
    }
    const actual = toView(api.state())
    const golden = goldenView(scenario)
    if (JSON.stringify(actual) !== JSON.stringify(golden)) {
      throw new Error('the api-mode end state differs from the golden end state')
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}
