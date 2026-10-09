import { emptyState, type State } from '../../engine/apply.js'
import { createOperation } from '../../engine/operation.js'
import { type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import { oracles } from './oracles.js'
import type { Scenario } from './scenario.js'
import { startApi } from './server.js'

// Issue #24, STORIES.md Test method: the golden-path runner. In api mode each
// step is an HTTP request against the in-process server; the end state is the
// server's. Issue #26 adds the dry mode: the same steps as a dry run, and the
// side-effect intents equal those of api mode (I7). Issue #28 runs the oracle
// pipeline over the end state: the invariants, the golden end state, then the
// timeline. A golden path is deterministic, so the runner never retries.

/** The run modes of a scenario (STORIES.md, Golden path): api now; cli and gui arrive later. */
export type Mode = 'api' | 'dry'

/** How many times to deliver each step's operation (same ID). */
export type Deliveries = (stepIndex: number) => number

/** What a run produced (I7): the end state, and the side-effect intents in step order. */
export type RunOutcome = {
  readonly state: State
  readonly intents: readonly OutboxEntry[]
}

/** The options of a run: the mode, and how many times api mode delivers each step. */
export type RunOptions = {
  readonly mode: Mode
  readonly deliveries?: Deliveries
}

/** Delivery once per step, the golden path. */
const ONCE: Deliveries = () => 1

// Execute a scenario in api mode, delivering each step's operation
// `deliveries(i)` times, and return the server's end state and outbox.
export async function runSteps(scenario: Scenario, options: RunOptions): Promise<RunOutcome> {
  if (options.mode === 'dry') {
    // Issue #26: the dry mode is not implemented yet.
    throw new Error('issue #26: the dry mode is not implemented')
  }
  const deliveries = options.deliveries ?? ONCE
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
    const state = api.state()
    return { state, intents: outboxOf(state.log) }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}

export async function runGolden(scenario: Scenario): Promise<void> {
  const { state } = await runSteps(scenario, { mode: 'api' })
  oracles(state, scenario)
}
