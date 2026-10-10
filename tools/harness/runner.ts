import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyState, type State } from '../../engine/apply.js'
import type { Operation } from '../../engine/operation.js'
import { type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import { runSteps as engineRunSteps } from '../../engine/run.js'
import { oracles } from './oracles.js'
import {
  fromView,
  goldenClock,
  type Scenario,
  type StateView,
  type StepClock,
  stepOperation,
  toView,
} from './scenario.js'
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

/** The options of a run: the mode, how many times api mode delivers each step, and the step clock. */
export type RunOptions = {
  readonly mode: Mode
  readonly deliveries?: Deliveries
  /** The injected step clock of the run (I6). Absent means the golden step clock. */
  readonly clock?: StepClock
}

/** Delivery once per step, the golden path. */
const ONCE: Deliveries = () => 1

/** The harness CLI (Issue #25), and the loader that resolves its `.js` imports. */
const HARNESS_DIR = fileURLToPath(new URL('.', import.meta.url))
const CLI_ENTRY = join(HARNESS_DIR, 'cli.ts')
const TS_RESOLVE = join(HARNESS_DIR, 'ts-resolve.ts')

/**
 * Run a scenario in one mode (STORIES.md, Golden path). Dry mode returns the
 * side-effect intents of the same steps (I7); api mode returns the server's
 * end state and the side effects that its log carries (I2); cli mode returns
 * the same end state as api mode through the harness CLI.
 */
export async function runSteps(scenario: Scenario, options: RunOptions): Promise<RunOutcome> {
  if (options.mode === 'dry') return dryRun(scenario)
  if (options.mode === 'cli') return cliRun(scenario)
  return apiRun(scenario, options.deliveries ?? ONCE, options.clock ?? goldenClock)
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
 * harness CLI. Each step is one `node` process that applies the step's
 * operation through the engine and prints the resulting state; the runner
 * threads that state into the next step, so the log keeps one global order
 * (I4) and the end state equals api mode's.
 */
async function cliRun(scenario: Scenario): Promise<RunOutcome> {
  let state = emptyState
  for (let i = 0; i < scenario.steps.length; i++) {
    state = await cliApply(stepOperation(scenario.steps[i], i), state)
  }
  return { state, intents: outboxOf(state.log) }
}

/** Apply one operation through the CLI process, and read the state it returns. */
async function cliApply(operation: Operation, state: State): Promise<State> {
  const stdout = await runCli([
    '--import',
    TS_RESOLVE,
    CLI_ENTRY,
    '--json',
    JSON.stringify(operation),
    '--state',
    JSON.stringify(toView(state)),
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`cli mode: the CLI did not return valid JSON\n${stdout}`)
  }
  return fromView(parsed as StateView)
}

/** Run the harness CLI, and reject with its stderr when it exits non-zero. */
function runCli(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`cli mode: ${error.message}\n${stderr}`))
      else resolve(stdout)
    })
  })
}

/** Run a scenario against the in-process server, delivering each step `deliveries(i)` times. */
async function apiRun(
  scenario: Scenario,
  deliveries: Deliveries,
  clock: StepClock
): Promise<RunOutcome> {
  const api = startApi(emptyState)
  const server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const operation = stepOperation(scenario.steps[i], i, clock)
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
