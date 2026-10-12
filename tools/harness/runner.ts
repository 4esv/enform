import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { chromium, type Page } from 'playwright'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import type { Operation } from '../../engine/operation.js'
import { type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import type { TargetResolver } from '../../engine/routing.js'
import { runSteps as engineRunSteps } from '../../engine/run.js'
import { oracles } from './oracles.js'
import {
  fromView,
  type GuiAction,
  type GuiFillValue,
  type GuiStep,
  goldenClock,
  goldenViewPrefix,
  type Scenario,
  type StateView,
  type Step,
  type StepClock,
  stepOperation,
  toView,
} from './scenario.js'
import { type Api, startApi } from './server.js'

// Issue #24, STORIES.md Test method: the golden-path runner. A scenario runs
// in one mode. In api mode each step is an HTTP request against the in-process
// server; in dry mode the same steps run as a dry run and the side-effect
// intents must equal those of api mode (Issue #26, I7); in cli mode each step
// runs through the harness CLI with `--json` (Issue #25) and the end state
// must equal api mode's. Issue #28 runs the oracle pipeline over the end
// state: the invariants, the golden end state, then the timeline. A golden
// path is deterministic, so the runner never retries.

/** The run modes of a scenario (STORIES.md, Golden path): api, cli, dry and gui. */
export type Mode = 'api' | 'dry' | 'cli' | 'gui'

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
  /** The directory resolver that resolves a start intent (ADR 0010); gui mode uses it. */
  readonly resolve?: TargetResolver
  /** The grants that apply to the acting principal; gui mode passes them to the API. */
  readonly grants?: readonly Grant[]
  /** The initial server state (the published flow); gui mode reads it, absent is empty. */
  readonly seed?: State
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
  if (options.mode === 'gui') return guiRun(scenario, options)
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

/**
 * gui mode (Issue #27, STORIES.md Golden path): run the scenario's declared
 * gui prefix in a browser. Each gui step opens the app at the step's actor,
 * performs its actions in order, and appends exactly one event; the runner
 * then checks that the event equals the engine step at the same index. The
 * browser's intent carries the injected step clock, operation ID source and
 * instance ID source (#187), so it reads `op-<i+1>`, `at = <i+1>` and the
 * instance id that the step declares, exactly as `stepOperation` builds them
 * (I6). The run returns the prefix end state, which the caller compares to api
 * mode's prefix; there is no retry (I6).
 */
async function guiRun(scenario: Scenario, options: RunOptions): Promise<RunOutcome> {
  const gui = scenario.gui
  if (gui === undefined) throw new Error('gui mode: the scenario declares no gui path')
  if (gui.length > scenario.steps.length) {
    throw new Error('gui mode: the gui path is longer than the scenario steps')
  }
  const clock = options.clock ?? goldenClock
  const flowSlug = scenario.flowSlug
  if (flowSlug === undefined) {
    throw new Error('gui mode: the scenario declares no flowSlug')
  }
  const api = startApi(options.seed ?? emptyState, {
    resolve: options.resolve,
    grants: options.grants,
  })
  const server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const seedLength = api.state().log.length
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    for (let i = 0; i < gui.length; i += 1) {
      const page = await context.newPage()
      try {
        await page.addInitScript(guiSources(scenario.steps[i], i, clock))
        await page.goto(guiUrl(api.port(), flowSlug, scenario.steps[i].actor, gui[i]))
        // The app loads the flow and renders the form asynchronously; wait for
        // the submit control before the step's actions touch the fields.
        await page.waitForSelector('form button[type="button"]', { timeout: 5000 })
        await performGuiActions(page, gui[i].actions)
        await waitForEvent(api, seedLength + i + 1)
        const state = api.state()
        if (state.log.length !== seedLength + i + 1) {
          throw new Error(
            `gui mode: step ${i + 1} appended ${state.log.length - seedLength - i} events, not one`
          )
        }
        const event = state.log[state.log.length - 1]
        const expected = stepOperation(scenario.steps[i], i, clock)
        const actual: Operation = {
          id: event.operationId,
          type: event.type,
          at: event.at,
          actor: event.actor,
          payload: event.payload,
        }
        if (!isDeepStrictEqual(actual, expected)) {
          throw new Error(`gui mode: step ${i + 1} did not map to its engine step`)
        }
      } finally {
        await page.close()
      }
    }
    const state = api.state()
    const scenarioState = replayPrefix(state, seedLength)
    if (!isDeepStrictEqual(toView(scenarioState), goldenViewPrefix(scenario, gui.length, clock))) {
      throw new Error('gui mode: the gui prefix differs from the engine prefix')
    }
    return { state: scenarioState, intents: outboxOf(scenarioState.log) }
  } finally {
    await browser.close()
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}

/**
 * The injected sources of one gui step (I6): the step clock, the operation ID
 * source `op-<n>`, and, when the declared step's payload holds one, the
 * instance id that the step's start minted (DX-1, #187). gui mode reads the
 * instance id back from the step's payload, so the browser and the golden step
 * agree without a second convention, and it JSON-escapes the id, so the
 * injected source returns exactly the string the step declares.
 */
function guiSources(step: Step, index: number, clock: StepClock): string {
  const instanceId = step.payload.instanceId
  const instanceIds =
    typeof instanceId === 'string' ? `, instanceIds: () => ${JSON.stringify(instanceId)}` : ''
  return `globalThis.__enformSources = { clock: () => ${clock(index)}, ids: () => 'op-${index + 1}'${instanceIds} }`
}

/** The app URL of one gui step: the flow, the step's actor, and its optional page. */
function guiUrl(port: number, slug: string, actor: string, step: GuiStep): string {
  const url = new URL('/app/', `http://127.0.0.1:${port}`)
  if (step.page !== undefined) url.pathname = `/app/${step.page}`
  url.searchParams.set('slug', slug)
  url.searchParams.set('actor', actor)
  return url.toString()
}

/** Perform one gui step's actions in order (STORIES.md, Interface path). */
async function performGuiActions(page: Page, actions: readonly GuiAction[]): Promise<void> {
  for (const action of actions) {
    if ('fill' in action) {
      await fillField(page, action.fill.field, action.fill.value)
    } else if ('click' in action) {
      await page.locator(action.click).click()
    } else {
      await page.waitForFunction(
        (expected) => {
          const status = document.querySelector('.status')
          return status !== null && status.textContent === expected
        },
        action.expect,
        { timeout: 5000 }
      )
    }
  }
}

/** Fill one form control by its field key (FM-1, FM-7). */
async function fillField(page: Page, field: string, value: GuiFillValue): Promise<void> {
  const element = page.locator(`[name="${field}"]`)
  const count = await element.count()
  if (count !== 1) {
    throw new Error(`gui mode: the field ${field} matched ${count} controls, not one`)
  }
  const control = element.first()
  const tag = await control.evaluate((node) => node.tagName.toLowerCase())
  if (tag === 'textarea') {
    await control.fill(String(value))
    return
  }
  if (tag === 'select') {
    await control.selectOption(String(value))
    return
  }
  if (tag === 'input') {
    const type = await control.getAttribute('type')
    if (type === 'checkbox') {
      await control.setChecked(Boolean(value))
      return
    }
    if (type === 'file' || type === 'radio') {
      throw new Error(`gui mode: cannot fill a ${type} control (${field})`)
    }
    await control.fill(String(value))
    return
  }
  throw new Error(`gui mode: cannot fill a ${tag} control (${field})`)
}

/** Wait for the in-process server to reach `length` events (one async browser submit). */
async function waitForEvent(api: Api, length: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (api.state().log.length < length) {
    if (Date.now() > deadline) {
      throw new Error('gui mode: the interface did not append its event in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * The scenario events of a gui run, replayed from the seeded server log. The
 * server appends the interface's events after the seed, so their `seq` counts
 * the seed too; a replay from the empty state renumbers them 1..n, exactly as
 * api mode produces them (I4).
 */
function replayPrefix(serverState: State, seedLength: number): State {
  let state = emptyState
  for (const event of serverState.log.slice(seedLength)) {
    state = apply(
      {
        id: event.operationId,
        type: event.type,
        at: event.at,
        actor: event.actor,
        payload: event.payload,
      },
      state
    )
  }
  return state
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
