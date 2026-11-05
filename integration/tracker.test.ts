import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #244, S14, VT-2, WF-1, WF-3, I4, I6, I8, I12: the per-step tracker
// against the real Compose stack and the demo seed. The tracker is one entry
// per definition step in definition order, with the state of the step, the
// holder of the open step, the condition that skipped a step and the comment
// that sent one back. The API reads it from the log (I4), a send back moves it,
// and `enform admin rebuild` reproduces it from the same events. Chromium shows
// the tracker on the demo request draft and the skipped condition text on the
// registrar instance. A start is a private draft on the request form and the
// submit routes it (ADR 0014), so the request form completes at the submit and
// the chair step, which follows the advisor, is skipped by the advisor's
// completion.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `tracker-admin-${RUN}@test.local`
const ADMIN_PASSWORD = `tracker-admin-${RUN}`
const REPO = join(import.meta.dirname, '..')
const COMMENT = 'Attach your degree audit'

/** The condition that skips the demo chair step when the credits are at most two. */
const CHAIR_CONDITION = { '<=': [{ var: 'credits' }, 2] }

/** One demo user as `seed demo --json` returns it. */
type DemoUser = {
  readonly role: string
  readonly displayName: string
  readonly email: string
  readonly id: string
  readonly password: string
}

/** One seeded instance as `seed demo --json` returns it. */
type DemoInstance = {
  readonly id: string
  readonly step: string
  readonly done: boolean
}

/** The JSON body of `seed demo`. */
type SeedOutput = {
  readonly ok: boolean
  readonly flow?: { readonly slug: string; readonly title: string; readonly url: string }
  readonly users?: readonly DemoUser[]
  readonly instances?: readonly DemoInstance[]
}

/** One step of the tracker as `GET /api/v1/instances/{id}` returns it. */
type TrackerStep = {
  readonly key: string
  readonly state: string
  readonly holder?: string
  readonly condition?: unknown
  readonly comment?: string
}

/** One instance view as `GET /api/v1/instances/{id}` returns it. */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: { readonly currentStep?: string; readonly holder?: string }
  readonly tracker: readonly TrackerStep[]
}

/** One event as `GET /api/v1/log` returns it. */
type Event = {
  readonly type: string
  readonly at: number
  readonly payload: Record<string, unknown>
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly browser: Browser
  readonly seed: SeedOutput
}

let setup: Setup | undefined
let setupError: unknown
/** The advisor instance's tracker after the send back, so a rebuild can reproduce it. */
let sentBackTracker: readonly TrackerStep[] | undefined

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-tracker-'))
    const databaseUrl = databaseUrlForRun(config.databaseUrl)
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const configPath = join(dir, 'enform.toml')
    const service = await startEnform(
      [
        'init',
        '--config',
        configPath,
        '--database-url',
        databaseUrl,
        '--public-url',
        publicUrl,
        '--admin-email',
        ADMIN_EMAIL,
        '--admin-password',
        ADMIN_PASSWORD,
        '--keycloak-url',
        config.keycloakUrl,
        '--keycloak-realm',
        config.realm,
        '--keycloak-admin-user',
        config.keycloakAdmin,
        '--keycloak-admin-password',
        config.keycloakAdminPassword,
        '--no-open',
      ],
      publicUrl
    )
    const seeded = runCli(['seed', 'demo', '--config', configPath, '--json'])
    if (seeded.status !== 0) throw new Error(`the demo seed failed: ${seeded.stderr}`)
    const browser = await chromium.launch()
    setup = {
      config,
      dir,
      configPath,
      publicUrl,
      service,
      browser,
      seed: JSON.parse(seeded.stdout) as SeedOutput,
    }
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  await setup?.browser.close()
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

/** The shared setup, or the reason the setup did not run. */
function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/** Run one synchronous CLI command and return its result. */
function runCli(args: readonly string[]): {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
} {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), ...args],
    { cwd: REPO, encoding: 'utf8' }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A demo user by role, or the reason the seed did not carry it. */
function castMember(role: string): DemoUser {
  const user = requireSetup().seed.users?.find((entry) => entry.role === role)
  if (user === undefined) throw new Error(`the demo seed has no ${role}`)
  return user
}

/** One seeded instance on a step, or the reason the seed did not carry it. */
function demoInstance(predicate: (instance: DemoInstance) => boolean): DemoInstance {
  const instance = requireSetup().seed.instances?.find(predicate)
  if (instance === undefined) throw new Error('the demo seed has no such instance')
  return instance
}

/** The demo flow slug, or the reason the seed did not carry it. */
function flowSlug(): string {
  const slug = requireSetup().seed.flow?.slug
  if (slug === undefined) throw new Error('the demo seed has no flow')
  return slug
}

/** Read one instance as a bearer principal. */
async function readAs(token: string, instanceId: string): Promise<InstanceView> {
  const { publicUrl } = requireSetup()
  return json<InstanceView>(
    await fetch(`${publicUrl}/api/v1/instances/${instanceId}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    `GET the instance ${instanceId}`
  )
}

/** Read the log as a bearer principal, so the expected times come from the events. */
async function readLogAs(token: string): Promise<readonly Event[]> {
  const { publicUrl } = requireSetup()
  return json<readonly Event[]>(
    await fetch(`${publicUrl}/api/v1/log`, { headers: { authorization: `Bearer ${token}` } }),
    'GET /api/v1/log'
  )
}

/** The time of the last event of one type that names one instance. */
function eventAt(log: readonly Event[], type: string, instanceId: string): number {
  const event = log.findLast(
    (candidate) => candidate.type === type && candidate.payload.instanceId === instanceId
  )
  if (event === undefined) throw new Error(`the log has no ${type} for ${instanceId}`)
  return event.at
}

/** Post one engine intent as a bearer principal. */
async function postIntent(token: string, intent: Record<string, unknown>): Promise<Response> {
  const { publicUrl } = requireSetup()
  return fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(intent),
  })
}

/** Sign in on the Keycloak page when the context has no session, then wait for the app. */
async function signIn(
  page: Page,
  publicUrl: string,
  email: string,
  password: string
): Promise<void> {
  const session = await page.request.get(`${publicUrl}/api/v1/session`)
  await page.goto(publicUrl)
  if (session.status() === 401) {
    await page.locator('#username').waitFor({ timeout: 30_000 })
    await page.fill('#username', email)
    await page.fill('#password', password)
    await page.click('#kc-login')
  }
  await page.locator('.app-header').waitFor({ timeout: 30_000 })
}

test('#244 VT-2 the request draft shows the unopened request form and the registrar instance the skipped chair', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const request = demoInstance((instance) => instance.step === 'request')
  const registrar = demoInstance((instance) => instance.step === 'registrar')
  const token = await passwordToken(config, sam.email, sam.password)
  const log = await readLogAs(token)

  // The draft sits on the request form and routes nothing yet (ADR 0014).
  const view = await readAs(token, request.id)
  const startedAt = eventAt(log, 'instance.started@1', request.id)
  expect(view.status.currentStep).toBe('request')
  expect(view.tracker).toEqual([
    { key: 'request', state: 'unopened', startAt: startedAt },
    { key: 'advisor', state: 'not-reached' },
    { key: 'chair', state: 'not-reached' },
    { key: 'registrar', state: 'not-reached' },
  ])

  // The advisor's completion skipped the chair step for two credits (WF-1,
  // S05): the registrar instance shows the condition and the unopened
  // registrar task.
  const routed = await readAs(token, registrar.id)
  const routedStartedAt = eventAt(log, 'instance.started@1', registrar.id)
  const submittedAt = eventAt(log, 'instance.submitted@1', registrar.id)
  const advisorAt = eventAt(log, 'step.completed@1', registrar.id)
  expect(routed.status.currentStep).toBe('registrar')
  expect(routed.tracker).toEqual([
    { key: 'request', state: 'completed', startAt: routedStartedAt, lastActivityAt: submittedAt },
    { key: 'advisor', state: 'completed', startAt: submittedAt, lastActivityAt: advisorAt },
    { key: 'chair', state: 'skipped', condition: CHAIR_CONDITION },
    {
      key: 'registrar',
      state: 'unopened',
      startAt: advisorAt,
      // The demo registrar step sets a two minute deadline (S12, SE-4).
      dueAt: advisorAt + 2 * 60_000,
    },
  ])
}, 180_000)

test('#244 VT-2 the demo request instance shows the tracker in Chromium', async () => {
  const { browser, publicUrl } = requireSetup()
  const sam = castMember('starter')
  const request = demoInstance((instance) => instance.step === 'request')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signIn(page, publicUrl, sam.email, sam.password)
    await page.goto(
      `${publicUrl}/?flow=${encodeURIComponent(flowSlug())}&instance=${encodeURIComponent(request.id)}`
    )
    await page.locator('[data-tracker]').waitFor({ timeout: 30_000 })

    const states = await page
      .locator('[data-tracker-state]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-tracker-state')))
    expect(states, 'each step shows its VT-2 state in definition order').toEqual([
      'unopened',
      'not-reached',
      'not-reached',
      'not-reached',
    ])
    expect(
      await page.locator('[data-tracker-step="chair"]').getAttribute('data-current')
    ).toBeNull()
    expect(
      await page.locator('[data-tracker-step="request"]').getAttribute('data-current'),
      'the current step is marked'
    ).toBe('')

    // The registrar instance shows the chair step the advisor's completion
    // skipped, with its condition (S05, VT-2).
    const registrar = demoInstance((instance) => instance.step === 'registrar')
    await page.goto(
      `${publicUrl}/?flow=${encodeURIComponent(flowSlug())}&instance=${encodeURIComponent(registrar.id)}`
    )
    await page.locator('[data-tracker]').waitFor({ timeout: 30_000 })
    expect(
      await page.locator('[data-tracker-step="chair"]').getAttribute('data-tracker-state')
    ).toBe('skipped')
    const reason = await page
      .locator('[data-tracker-step="chair"] .tracker-condition')
      .textContent()
    expect(reason, 'the skipped step shows its condition').toContain('credits')
    expect(reason).toContain('<=')
  } finally {
    await context.close()
  }
}, 180_000)

test('#244 VT-2 the advisor instance shows the request completed and the advisor unopened', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const advisor = demoInstance((instance) => instance.step === 'advisor')
  const token = await passwordToken(config, sam.email, sam.password)
  const view = await readAs(token, advisor.id)
  const log = await readLogAs(token)
  const startedAt = eventAt(log, 'instance.started@1', advisor.id)
  const submittedAt = eventAt(log, 'instance.submitted@1', advisor.id)

  // The submit completed the request form and entered the advisor step (ADR
  // 0014); the chair step follows the advisor, so nothing skipped it yet.
  expect(view.tracker).toEqual([
    { key: 'request', state: 'completed', startAt: startedAt, lastActivityAt: submittedAt },
    { key: 'advisor', state: 'unopened', startAt: submittedAt },
    { key: 'chair', state: 'not-reached' },
    { key: 'registrar', state: 'not-reached' },
  ])
}, 180_000)

test('#244 VT-2 the done instance shows every step completed or skipped', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const done = demoInstance((instance) => instance.done)
  const token = await passwordToken(config, sam.email, sam.password)
  const view = await readAs(token, done.id)
  const log = await readLogAs(token)
  const startedAt = eventAt(log, 'instance.started@1', done.id)
  const requestAt = eventAt(log, 'instance.submitted@1', done.id)
  const completed = log.filter(
    (event) => event.type === 'step.completed@1' && event.payload.instanceId === done.id
  )
  const [advisorAt, registrarAt] = completed.map((event) => event.at)
  if (advisorAt === undefined || registrarAt === undefined) {
    throw new Error('the done instance has no two completions')
  }

  // The submit completed the request form, the advisor's completion skipped
  // the chair step, and the registrar's completion finished the instance.
  expect(view.tracker).toEqual([
    { key: 'request', state: 'completed', startAt: startedAt, lastActivityAt: requestAt },
    { key: 'advisor', state: 'completed', startAt: requestAt, lastActivityAt: advisorAt },
    { key: 'chair', state: 'skipped', condition: CHAIR_CONDITION },
    {
      key: 'registrar',
      state: 'completed',
      startAt: advisorAt,
      lastActivityAt: registrarAt,
      // The demo registrar step sets a two minute deadline (S12, SE-4).
      dueAt: advisorAt + 2 * 60_000,
    },
  ])
}, 180_000)

test('#244 VT-2 a send back moves the tracker to the target step with the comment', async () => {
  const { config } = requireSetup()
  const okafor = castMember('advisor')
  const sam = castMember('starter')
  const instance = demoInstance((entry) => entry.step === 'advisor')
  const token = await passwordToken(config, okafor.email, okafor.password)

  // Okafor claims the advisor task, then sends it back to the request step
  // through the engine's intent path (S11, WF-3, I5).
  const before = await readAs(token, instance.id)
  const claim = await postIntent(token, {
    id: randomUUID(),
    type: 'step.claimed@1',
    at: Date.now(),
    actor: okafor.id,
    payload: { instanceId: instance.id, expectedVersion: before.version },
  })
  expect(claim.status, await claim.text()).toBe(201)
  const held = await readAs(token, instance.id)
  expect(held.status.holder, 'the advisor step is opened by its holder').toBe(okafor.id)
  const sent = await postIntent(token, {
    id: randomUUID(),
    type: 'step.sent-back@1',
    at: Date.now(),
    actor: okafor.id,
    payload: {
      instanceId: instance.id,
      to: 'request',
      comment: COMMENT,
      version: held.version,
    },
  })
  expect(sent.status, await sent.text()).toBe(201)

  // A send back to the request form makes the instance a draft again (ADR
  // 0014), so its starter reads it.
  const samToken = await passwordToken(config, sam.email, sam.password)
  const moved = await readAs(samToken, instance.id)
  // The log read is authorized the same way (#256, I8): the draft's events
  // are the starter's to read, so the expected times come from Sam's read.
  const log = await readLogAs(samToken)
  const submittedAt = eventAt(log, 'instance.submitted@1', instance.id)
  const sentBackAt = eventAt(log, 'step.sent-back@1', instance.id)
  expect(moved.status.currentStep).toBe('request')
  // The sending step keeps the state the log records for it: Okafor claimed
  // the advisor step and the send back records no completion for it.
  expect(moved.tracker).toEqual([
    {
      key: 'request',
      state: 'sent-back',
      comment: COMMENT,
      startAt: sentBackAt,
      lastActivityAt: sentBackAt,
    },
    { key: 'advisor', state: 'opened', startAt: submittedAt, lastActivityAt: sentBackAt },
    { key: 'chair', state: 'not-reached' },
    { key: 'registrar', state: 'not-reached' },
  ])
  sentBackTracker = moved.tracker
}, 180_000)

test('#250 VT-2 the tracker and the inbox show the relative due label in Chromium', async () => {
  const { browser, publicUrl } = requireSetup()
  const sam = castMember('starter')
  const done = demoInstance((instance) => instance.done)
  const registrar = demoInstance((instance) => instance.step === 'registrar')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signIn(page, publicUrl, sam.email, sam.password)

    // The done instance entered the registrar step, which sets a two minute
    // deadline, so the tracker carries the relative label and keeps the
    // absolute time for the tooltip and the datetime attribute (VT-2).
    await page.goto(
      `${publicUrl}/?flow=${encodeURIComponent(flowSlug())}&instance=${encodeURIComponent(done.id)}`
    )
    const trackerDue = page.locator('[data-tracker-step="registrar"] [data-tracker-due]')
    await trackerDue.waitFor({ timeout: 30_000 })
    // The tracker says the day in plain words and keeps the relative label
    // in parentheses (VT-2): "Due today (due in 2 minutes)".
    expect(await trackerDue.textContent()).toMatch(/^Due .*\((due in|overdue by) /)
    const trackerAbsolute = await trackerDue.getAttribute('datetime')
    expect(trackerAbsolute, 'the absolute time stays on the datetime attribute').toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    )
    expect(await trackerDue.getAttribute('title')).toBe(trackerAbsolute)

    // The open registrar instance is in the starter's Started tab, and the
    // inbox item shows the same relative label (VT-1, VT-2).
    await page.goto(`${publicUrl}/?inbox=1&tab=started`)
    const item = page.locator(`[data-inbox-instance="${registrar.id}"]`)
    await item.waitFor({ timeout: 30_000 })
    const inboxDue = item.locator('[data-inbox-due]')
    await inboxDue.waitFor({ timeout: 30_000 })
    expect(await inboxDue.textContent()).toMatch(/^(due in|overdue by) /)
    const inboxAbsolute = await inboxDue.getAttribute('datetime')
    expect(inboxAbsolute, 'the absolute time stays on the datetime attribute').toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    )
    expect(await inboxDue.getAttribute('title')).toBe(inboxAbsolute)
  } finally {
    await context.close()
  }
}, 180_000)

test('#244 I4 a rebuild reproduces the tracker from the log', async () => {
  const { config, configPath } = requireSetup()
  const sam = castMember('starter')
  const instance = demoInstance((entry) => entry.step === 'advisor')
  if (sentBackTracker === undefined) throw new Error('the send back test did not run')

  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)

  const view = await readAs(await passwordToken(config, sam.email, sam.password), instance.id)
  expect(view.tracker, 'the rebuild folds the same events into the same tracker').toEqual(
    sentBackTracker
  )
}, 180_000)
