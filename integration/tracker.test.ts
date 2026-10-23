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
// the tracker on the demo request instance with the skipped condition text.

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

test('#244 VT-2 the request instance shows the skipped chair and the unopened request', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const request = demoInstance((instance) => instance.step === 'request')
  const token = await passwordToken(config, sam.email, sam.password)
  const view = await readAs(token, request.id)
  const startedAt = eventAt(await readLogAs(token), 'instance.started@1', request.id)

  expect(view.status.currentStep).toBe('request')
  expect(view.tracker).toEqual([
    { key: 'chair', state: 'skipped', condition: CHAIR_CONDITION },
    { key: 'request', state: 'unopened', startAt: startedAt },
    { key: 'advisor', state: 'not-reached' },
    { key: 'registrar', state: 'not-reached' },
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
      'skipped',
      'unopened',
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
  const completedAt = eventAt(log, 'step.completed@1', advisor.id)

  expect(view.tracker).toEqual([
    { key: 'chair', state: 'skipped', condition: CHAIR_CONDITION },
    { key: 'request', state: 'completed', startAt: startedAt, lastActivityAt: completedAt },
    { key: 'advisor', state: 'unopened', startAt: completedAt },
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
  const completed = log.filter(
    (event) => event.type === 'step.completed@1' && event.payload.instanceId === done.id
  )
  const [requestAt, advisorAt, registrarAt] = completed.map((event) => event.at)
  if (requestAt === undefined || advisorAt === undefined || registrarAt === undefined) {
    throw new Error('the done instance has no three completions')
  }

  expect(view.tracker).toEqual([
    { key: 'chair', state: 'skipped', condition: CHAIR_CONDITION },
    { key: 'request', state: 'completed', startAt: startedAt, lastActivityAt: requestAt },
    { key: 'advisor', state: 'completed', startAt: requestAt, lastActivityAt: advisorAt },
    { key: 'registrar', state: 'completed', startAt: advisorAt, lastActivityAt: registrarAt },
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

  const moved = await readAs(await passwordToken(config, sam.email, sam.password), instance.id)
  const log = await readLogAs(token)
  const completedAt = eventAt(log, 'step.completed@1', instance.id)
  const sentBackAt = eventAt(log, 'step.sent-back@1', instance.id)
  expect(moved.status.currentStep).toBe('request')
  // The sending step keeps the state the log records for it: Okafor claimed
  // the advisor step and the send back records no completion for it.
  expect(moved.tracker).toEqual([
    { key: 'chair', state: 'skipped', condition: CHAIR_CONDITION },
    {
      key: 'request',
      state: 'sent-back',
      comment: COMMENT,
      startAt: sentBackAt,
      lastActivityAt: sentBackAt,
    },
    { key: 'advisor', state: 'opened', startAt: completedAt, lastActivityAt: sentBackAt },
    { key: 'registrar', state: 'not-reached' },
  ])
  sentBackTracker = moved.tracker
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
