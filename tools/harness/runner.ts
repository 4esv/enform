import { emptyState, type State } from '../../engine/apply.js'
import { type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import { runSteps as engineRunSteps } from '../../engine/run.js'
import { oracles } from './oracles.js'
import { type Scenario, stepOperation } from './scenario.js'
import { startApi } from './server.js'

// Issue #24, STORIES.md Test method: the golden-path runner. A scenario runs
// in one mode. In api mode each step is an HTTP request against the in-process
// server; in dry mode the same steps run as a dry run and the side-effect
// intents must equal those of api mode (Issue #26, I7); in cli mode each step
// runs through the harness CLI with `--json` (Issue #25) and the end state
// must equal api mode's. Issue #28 runs the oracle pipeline over the end
// state: the invariants, the golden end state, then the timeline. A golden
// path is deterministic, so the runner never retries.

/** The run modes of a scenario (STORIES.md, Golden path): api, cli and dry; gui arrives later. */
export type Mode = 'api' | 'dry' | 'cli'

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

/**
 * Run a scenario in one mode (STORIES.md, Golden path). Dry mode returns the
 * side-effect intents of the same steps (I7); api mode returns the server's
 * end state and the side effects that its log carries (I2); cli mode returns
 * the same end state as api mode through the harness CLI.
 */
export async function runSteps(scenario: Scenario, options: RunOptions): Promise<RunOutcome> {
  if (options.mode === 'dry') return dryRun(scenario)
  if (options.mode === 'cli') return cliRun(scenario)
  return apiRun(scenario, options.deliveries ?? ONCE)
}

/**
 * Dry mode (Issue #26, I7): map the scenario's steps onto the engine run with
 * the dry sink. One loop serves the state change and its side effects, and the
 * dry sink commits nothing (A6), so the run reads the same side effects as api
 * mode and returns them as intents. The dry sink writes no operation, so it
 * reads neither injected source; the clock stays a simulation (DR-4).
 */
function dryRun(scenario: Scenario): RunOutcome {
  const run = engineRunSteps(
    scenario.steps.map((step) => ({
      type: step.type,
      payload: step.payload,
      actor: step.actor,
      outbox: step.outbox,
    })),
    { clock: () => 0, ids: () => '', sink: 'dry' }
  )
  return { state: run.state, intents: run.intents }
}

/**
 * cli mode (Issue #25, STORIES.md Golden path): run every step through the
 * harness CLI. Scaffold for issue #25: the CLI is not wired yet, so the mode
 * returns the empty outcome. The next commit runs each step through `cli.ts`
 * and threads the state between steps.
 */
async function cliRun(_scenario: Scenario): Promise<RunOutcome> {
  return { state: emptyState, intents: [] }
}

/** Run a scenario against the in-process server, delivering each step `deliveries(i)` times. */
async function apiRun(scenario: Scenario, deliveries: Deliveries): Promise<RunOutcome> {
  const api = startApi(emptyState)
  const server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const operation = stepOperation(scenario.steps[i], i)
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
