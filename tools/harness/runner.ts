import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { type BrowserContext, chromium, type Page } from 'playwright'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import type { Operation } from '../../engine/operation.js'
import { type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import type { TargetResolver } from '../../engine/routing.js'
import { runSteps as engineRunSteps } from '../../engine/run.js'
import { oracles } from './oracles.js'
import {
  assertGoldenDeclared,
  continueFrom,
  type Prediction,
  postedOperation,
  predict,
  type StepOutcome,
  sameOperation,
} from './predict.js'
import {
  clockOf,
  fromView,
  type GuiAction,
  type GuiDomExpectation,
  type GuiFillValue,
  type GuiStep,
  goldenViewPrefix,
  guiCoverage,
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
  return apiRun(scenario, options.deliveries ?? ONCE, options.clock ?? clockOf(scenario), options)
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
    const step = scenario.steps[i]
    const operation = stepOperation(step, i, clockOf(scenario))
    const posted = step.intent === undefined ? operation : { ...operation, payload: step.intent }
    state = await cliApply(posted, state, scenario)
    if (step.intent !== undefined) {
      const event = state.log.find((entry) => entry.operationId === operation.id)
      const actual =
        event === undefined
          ? undefined
          : {
              id: event.operationId,
              type: event.type,
              at: event.at,
              actor: event.actor,
              payload: event.payload,
            }
      if (!sameOperation(actual, operation)) {
        throw new Error(
          `cli mode: step ${i + 1} resolved to an event that differs from the declared step`
        )
      }
    }
  }
  return { state, intents: outboxOf(state.log) }
}

/** Apply one operation through the CLI process, and read the state it returns. */
async function cliApply(operation: Operation, state: State, scenario: Scenario): Promise<State> {
  const stdout = await runCli([
    '--import',
    TS_RESOLVE,
    CLI_ENTRY,
    '--json',
    JSON.stringify(operation),
    '--state',
    JSON.stringify(toView(state)),
    '--bootstrap',
    JSON.stringify(scenario.bootstrap ?? []),
    '--membership',
    JSON.stringify(scenario.membership ?? {}),
    '--managers',
    JSON.stringify(scenario.managers ?? {}),
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
  if (guiCoverage(gui) > scenario.steps.length) {
    throw new Error('gui mode: the gui path is longer than the scenario steps')
  }
  const clock = options.clock ?? clockOf(scenario)
  const flowSlug = scenario.flowSlug
  if (flowSlug === undefined) {
    throw new Error('gui mode: the scenario declares no flowSlug')
  }
  const api = startApi(options.seed ?? emptyState, {
    resolve: options.resolve,
    grants: options.grants,
    bootstrap: scenario.bootstrap,
    membership: scenario.membership,
    managers: scenario.managers,
  })
  const server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const seedLength = api.state().log.length
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    // A gui step covers one engine step, or several when the page posts the
    // start, each edit and the submit itself (#262, RT-3): `first` is the
    // index of the first engine step it covers.
    let first = 0
    for (let i = 0; i < gui.length; i += 1) {
      const covered = gui[i].steps ?? 1
      const page = await context.newPage()
      // The browser's errors travel with a failure, so a step that appended
      // nothing names the exception behind it.
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      try {
        // A gui step that only reads sits after the last engine step it could
        // cover (#269): its sources are the last step's, and it posts nothing.
        const covering = scenario.steps[Math.min(first, scenario.steps.length - 1)]
        await page.addInitScript(guiSources(covering, first, clock))
        await page.goto(guiUrl(api.port(), flowSlug, gui[i].actor ?? covering.actor, gui[i]))
        try {
          // The app loads the flow and renders the page asynchronously; wait
          // for a control before the step's actions touch the fields. A page
          // that never renders reports the browser's errors with the failure.
          await page.waitForSelector('button[type="button"], [data-page-ready]', {
            timeout: 5000,
          })
          await performGuiActions(page, context, api, seedLength, gui[i].actions)
          await waitForEvent(api, seedLength + first + covered)
        } catch (error) {
          const detail = errors.length === 0 ? '' : `\nbrowser errors:\n${errors.join('\n')}`
          const status = await page
            .locator('.status')
            .first()
            .textContent()
            .catch(() => null)
          const seen = api
            .state()
            .log.slice(seedLength)
            .map((event) => event.type)
            .join(', ')
          // The first appended event that differs from its declared step
          // names what the page posted instead.
          let mismatch = ''
          api
            .state()
            .log.slice(seedLength)
            .some((event, k) => {
              const step = scenario.steps[k]
              if (step === undefined) return false
              const expected = stepOperation(step, k, clock)
              const actual = {
                id: event.operationId,
                type: event.type,
                at: event.at,
                actor: event.actor,
                payload: event.payload,
              }
              if (sameOperation(actual, expected)) return false
              mismatch = `\nfirst mismatch at engine step ${k + 1}:\n${JSON.stringify(actual)}\n${JSON.stringify(expected)}`
              return true
            })
          throw new Error(
            `gui mode: step ${i + 1}: ${error instanceof Error ? error.message : String(error)} (status: ${String(status)}; events so far: ${seen || 'none'})${mismatch}${detail}`
          )
        }
        const state = api.state()
        if (state.log.length !== seedLength + first + covered) {
          throw new Error(
            `gui mode: step ${i + 1} appended ${state.log.length - seedLength - first} events, not ${covered}`
          )
        }
        for (let k = 0; k < covered; k += 1) {
          const event = state.log[seedLength + first + k]
          const expected = stepOperation(scenario.steps[first + k], first + k, clock)
          const actual: Operation = {
            id: event.operationId,
            type: event.type,
            at: event.at,
            actor: event.actor,
            payload: event.payload,
          }
          if (!sameOperation(actual, expected)) {
            throw new Error(
              `gui mode: step ${i + 1} did not map to engine step ${first + k + 1}\n${JSON.stringify(actual)}\n${JSON.stringify(expected)}`
            )
          }
        }
        first += covered
      } finally {
        await page.close()
      }
    }
    const state = api.state()
    const scenarioState = replayPrefix(state, seedLength)
    if (!isDeepStrictEqual(toView(scenarioState), goldenViewPrefix(scenario, first, clock))) {
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
  // The sources count from the step the page covers first: a page that posts
  // several operations gets `op-<n>`, `op-<n+1>` and the clock of each step,
  // exactly as `stepOperation` builds them (#262, I6).
  // The counters live in the tab's session storage, so a reload within one
  // gui step keeps minting the next id and the next time (RT-4, I6).
  const clocks = JSON.stringify(Array.from({ length: 64 }, (_, offset) => clock(index + offset)))
  return `globalThis.__enformSources = (() => {
    const read = (name, start) => Number(sessionStorage.getItem(name) ?? start)
    const bump = (name, start) => { const next = read(name, start) + 1; sessionStorage.setItem(name, String(next)); return next }
    const clocks = ${clocks}
    return {
      clock: () => clocks[Math.min(bump('__enformClock', -1), clocks.length - 1)],
      // The step's time without advancing the clock: what the page labels
      // and compares with, so a read never consumes an operation's time (I6).
      now: () => clocks[Math.min(read('__enformClock', -1) + 1, clocks.length - 1)],
      ids: () => 'op-' + bump('__enformIds', ${index})${instanceIds}
    }
  })()`
}

/** The app URL of one gui step: the flow, the step's actor, and its optional page. */
function guiUrl(port: number, slug: string, actor: string, step: GuiStep): string {
  const url = new URL('/app/', `http://127.0.0.1:${port}`)
  if (step.page !== undefined) url.pathname = `/app/${step.page}`
  url.searchParams.set('slug', slug)
  url.searchParams.set('actor', actor)
  if (step.instance !== undefined) url.searchParams.set('instance', step.instance)
  return url.toString()
}

/** Perform one gui step's actions in order (STORIES.md, Interface path). */
async function performGuiActions(
  page: Page,
  context: BrowserContext,
  api: Api,
  seedLength: number,
  actions: readonly GuiAction[]
): Promise<void> {
  for (const action of actions) {
    if ('fill' in action) {
      await fillField(page, action.fill.field, action.fill.value)
    } else if ('click' in action) {
      await page.locator(action.click).click()
    } else if ('expectDom' in action) {
      await expectFieldDom(page, action.expectDom)
    } else if ('expectSelector' in action) {
      await page.locator(action.expectSelector).first().waitFor({ timeout: 10_000 })
    } else if ('expectValue' in action) {
      await page.waitForFunction(
        ({ field, value }) =>
          (document.querySelector(`[name="${field}"]`) as HTMLInputElement | null)?.value === value,
        action.expectValue,
        { timeout: 10_000 }
      )
    } else if ('expectText' in action) {
      await page.waitForFunction(
        ({ selector, text }) => document.querySelector(selector)?.textContent === text,
        action.expectText,
        { timeout: 10_000 }
      )
    } else if ('offline' in action) {
      if (action.offline) {
        // A refresh without a connection needs the shell in the worker's
        // cache (RT-4): wait until the worker controls the page.
        await page
          .waitForFunction(
            () => document.documentElement.dataset.offlineReady === 'true',
            undefined,
            { timeout: 10_000 }
          )
          .catch(() => undefined)
      }
      await context.setOffline(action.offline)
      if (!action.offline) await page.evaluate(() => window.dispatchEvent(new Event('online')))
    } else if ('reload' in action) {
      await page.reload()
      await page.waitForSelector('button[type="button"], [data-page-ready]', { timeout: 5000 })
    } else if ('expectEvents' in action) {
      await waitForEvent(api, seedLength + action.expectEvents)
    } else if ('type' in action) {
      await page.locator(action.type.selector).first().fill(action.type.text)
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

/**
 * Assert the DOM that one field renders (FM-1): its tag, its input type and,
 * when the expectation gives one, its count. A field is found by its name,
 * and a field with no named control (static text, repeating section) by its
 * data-field marker.
 */
async function expectFieldDom(page: Page, expected: GuiDomExpectation): Promise<void> {
  const byName = page.locator(`[name="${expected.field}"]`)
  const elements =
    (await byName.count()) > 0 ? byName : page.locator(`[data-field="${expected.field}"]`)
  const count = await elements.count()
  if (count === 0) throw new Error(`gui mode: the field ${expected.field} rendered no control`)
  if (expected.count !== undefined && count !== expected.count) {
    throw new Error(
      `gui mode: the field ${expected.field} rendered ${count} controls, not ${expected.count}`
    )
  }
  const nodes = await elements.evaluateAll((list) =>
    list.map((node) => ({
      tag: node.tagName.toLowerCase(),
      type: node instanceof HTMLInputElement ? node.type : undefined,
    }))
  )
  for (const node of nodes) {
    if (node.tag !== expected.tag) {
      throw new Error(
        `gui mode: the field ${expected.field} renders ${node.tag}, not ${expected.tag}`
      )
    }
    if (expected.type !== undefined && node.type !== expected.type) {
      throw new Error(
        `gui mode: the field ${expected.field} renders type ${String(node.type)}, not ${expected.type}`
      )
    }
  }
}

/** Fill one form control by its field key (FM-1, FM-7). */
async function fillField(page: Page, field: string, value: GuiFillValue): Promise<void> {
  const elements = page.locator(`[name="${field}"]`)
  const count = await elements.count()
  if (count === 0) {
    throw new Error(`gui mode: the field ${field} matched ${count} controls, not one`)
  }
  const control = elements.first()
  const tag = await control.evaluate((node) => node.tagName.toLowerCase())
  if (tag === 'input') {
    const type = await control.getAttribute('type')
    if (type === 'radio') {
      const wanted = String(value)
      const index = await elements.evaluateAll(
        (nodes, target) => nodes.findIndex((node) => (node as HTMLInputElement).value === target),
        wanted
      )
      if (index < 0) {
        throw new Error(`gui mode: the field ${field} has no radio with value ${wanted}`)
      }
      await elements.nth(index).check()
      return
    }
    if (type === 'checkbox' && Array.isArray(value)) {
      const wanted = value.map((entry) => String(entry))
      const indexes = await elements.evaluateAll(
        (nodes, options) =>
          nodes.flatMap((node, index) =>
            options.includes((node as HTMLInputElement).value) ? [index] : []
          ),
        wanted
      )
      for (const index of indexes) await elements.nth(index).check()
      return
    }
    if (type === 'file') {
      if (count !== 1) {
        throw new Error(`gui mode: the field ${field} matched ${count} file inputs, not one`)
      }
      await control.setInputFiles({
        name: String(value),
        mimeType: 'text/plain',
        buffer: Buffer.from(''),
      })
      return
    }
  }
  if (count !== 1) {
    throw new Error(`gui mode: the field ${field} matched ${count} controls, not one`)
  }
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

/**
 * Post one step to the harness server, `times` times with the same id (I1),
 * and check the server against the engine's prediction of the step (ADR
 * 0010, #256): an applied step answers 201 with the predicted event, a
 * refused step answers the predicted status and appends nothing. The caller
 * owns the server; the Offline operator and api mode share this one path.
 */
export async function postStep(
  api: Api,
  step: Step,
  index: number,
  clock: StepClock,
  times: number,
  expected: StepOutcome
): Promise<void> {
  const posted = postedOperation(step, index, clock)
  const before = api.state().log.length
  for (let d = 0; d < times; d += 1) {
    const response = await fetch(`http://127.0.0.1:${api.port()}/api/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(posted),
    })
    const body = await response.text()
    if ('operation' in expected) {
      if (response.status !== 201) {
        throw new Error(
          `step ${index + 1} delivery ${d + 1} failed: HTTP ${response.status} ${body}`
        )
      }
      continue
    }
    if (response.status !== expected.status) {
      throw new Error(
        `step ${index + 1} delivery ${d + 1}: the engine predicts HTTP ${expected.status} (${expected.error}), the server answered HTTP ${response.status} ${body}`
      )
    }
    if (api.state().log.length !== before) {
      throw new Error(`step ${index + 1}: a refused step appended an event`)
    }
  }
  if ('error' in expected) return
  const event = api.state().log.find((entry) => entry.operationId === posted.id)
  const actual =
    event === undefined
      ? undefined
      : {
          id: event.operationId,
          type: event.type,
          at: event.at,
          actor: event.actor,
          payload: event.payload,
        }
  if (!sameOperation(actual, expected.operation)) {
    throw new Error(
      `step ${index + 1}: the server's event differs from the engine's prediction\n${JSON.stringify(actual)}\n${JSON.stringify(expected.operation)}`
    )
  }
}

/** Start the harness server for a scenario, run `body` against it, and close it. */
export async function withScenarioApi<T>(
  scenario: Scenario,
  body: (api: Api) => Promise<T>,
  seed: State = emptyState
): Promise<T> {
  const api = startApi(seed, {
    bootstrap: scenario.bootstrap,
    membership: scenario.membership,
    managers: scenario.managers,
  })
  const server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await body(api)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}

/** Run a scenario against the in-process server, delivering each step `deliveries(i)` times. */
async function apiRun(
  scenario: Scenario,
  deliveries: Deliveries,
  clock: StepClock,
  options: RunOptions
): Promise<RunOutcome> {
  // A seeded run (the published flow, as gui mode reads it) predicts from
  // the seed and answers the scenario's own events, renumbered from one, so
  // the modes compare event for event (I4).
  const seed = options.seed ?? emptyState
  const prediction: Prediction = continueFrom(scenario, seed, 0, clock)
  return withScenarioApi(
    scenario,
    async (api) => {
      for (let i = 0; i < scenario.steps.length; i++) {
        await postStep(api, scenario.steps[i], i, clock, deliveries(i), prediction.outcomes[i])
      }
      const state = seed.log.length === 0 ? api.state() : replayPrefix(api.state(), seed.log.length)
      return { state, intents: outboxOf(state.log) }
    },
    seed
  )
}

/**
 * The predicted outcome of every step of an api run (STORIES.md, Oracles): a
 * test reads it to assert the deviation an operator predicts, next to the
 * end state the oracles check.
 */
export function predictedOutcomes(
  scenario: Scenario,
  clock: StepClock = clockOf(scenario)
): readonly StepOutcome[] {
  return predict(scenario, clock).outcomes
}

export async function runGolden(scenario: Scenario): Promise<void> {
  assertGoldenDeclared(scenario)
  const { state } = await runSteps(scenario, { mode: 'api' })
  oracles(state, scenario)
}

/**
 * The golden path in the three engine modes (STORIES.md, Golden path): the
 * api run and the cli run reach the same end state, event for event, and the
 * dry run's side-effect intents equal theirs (I7). The api run is answered,
 * so a story test can check it further.
 */
export async function runModes(scenario: Scenario): Promise<RunOutcome> {
  if (scenario.steps.length === 0) throw new Error('the scenario has no step to run')
  const api = await runSteps(scenario, { mode: 'api' })
  const cli = await runSteps(scenario, { mode: 'cli' })
  const dry = await runSteps(scenario, { mode: 'dry' })
  if (!isDeepStrictEqual(toView(cli.state), toView(api.state))) {
    throw new Error('cli mode and api mode differ in their end state')
  }
  if (!isDeepStrictEqual(cli.intents, api.intents)) {
    throw new Error('cli mode and api mode differ in their side effects')
  }
  if (!isDeepStrictEqual(dry.intents, api.intents)) {
    throw new Error('dry mode and api mode differ in their side effects (I7)')
  }
  return api
}
