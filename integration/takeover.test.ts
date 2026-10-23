import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #242, S10, AS-3, WF-5, AC-4, I2, I4, I5, I8, I14, SE-2: take over a
// claimed task after the step's idle period, against the real Compose stack.
// `enform seed demo` loads the registrar step with `takeover: after-idle` and a
// one minute idle period. Ana claims the registrar task in the browser; Lee
// sees the Take over control, disabled with the remaining time, and the server
// refuses his takeover. A second registrar instance is claimed as Ana two
// minutes ago, so Lee's browser takeover succeeds: the holder moves to Lee,
// both inboxes follow, the worker sends the `send-takeover` email to Ana, and a
// rebuild keeps the holder and the attributed event. The test drives the app's
// own controls and waits on them, never on a fixed timeout.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `takeover-admin-${RUN}@test.local`
const ADMIN_PASSWORD = '<redacted>'
const REPO = join(import.meta.dirname, '..')
const REASON = 'Lee is out until 10/19'
const IDLE_MINUTES = 1
const IDLE_MS = IDLE_MINUTES * 60_000
const BACKDATED_CLAIM_MS = 2 * IDLE_MS

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

/** One instance view as `GET /api/v1/instances/{id}` returns it. */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: {
    readonly step: number
    readonly totalSteps: number
    readonly currentStep?: string
    readonly holder?: string
    readonly state: string
  }
  readonly outcomes: readonly string[]
  readonly canTakeOver: boolean
  readonly takeoverAvailableAt?: number
}

/** One event as `GET /api/v1/log` returns it. */
type Event = {
  readonly seq: number
  readonly type: string
  readonly at: number
  readonly actor?: string
  readonly payload: Record<string, unknown>
}

/** One outbox row as the test reads it from PostgreSQL. */
type OutboxRow = {
  readonly effect: string
  readonly status: string
  readonly payload: string
  readonly instanceId: string
}

/** One message in Mailpit's list response. */
type MailpitMessage = {
  readonly ID: string
  readonly Subject: string
  readonly To: readonly { readonly Address: string }[]
}

/** One message in Mailpit's detail response. */
type MailpitMessageDetail = MailpitMessage & {
  readonly Text: string
  readonly HTML: string
}

/** A worker child and the way to stop it. */
type WorkerChild = {
  readonly child: ChildProcess
  readonly stop: () => Promise<void>
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly browser: Browser
  readonly seed: SeedOutput
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-takeover-'))
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
        '--smtp-url',
        config.smtpUrl,
        '--mail-from',
        config.mailFrom,
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
      databaseUrl,
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

/** The shared setup, or the reason that `enform init` did not produce it. */
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

/** A demo user by role, or the reason the seed did not carry it. */
function castMember(role: string): DemoUser {
  const user = requireSetup().seed.users?.find((entry) => entry.role === role)
  if (user === undefined) throw new Error(`the demo seed has no ${role}`)
  return user
}

/** A seeded instance by the step it waits on, or the reason the seed did not carry it. */
function seededInstance(step: string): DemoInstance {
  const instance = requireSetup().seed.instances?.find((entry) => entry.step === step)
  if (instance === undefined) throw new Error(`the demo seed has no instance at ${step}`)
  return instance
}

/** The URL of one task page. */
function taskUrl(instanceId: string): string {
  const slug = requireSetup().seed.flow?.slug ?? ''
  const { publicUrl } = requireSetup()
  return `${publicUrl}/?flow=${encodeURIComponent(slug)}&instance=${encodeURIComponent(instanceId)}`
}

/** One API request with a bearer token. */
async function api(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${requireSetup().publicUrl}${path}`, { ...init, headers })
}

/** Read one JSON API response with a bearer token, or name the request that failed. */
async function apiJson<T>(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<T> {
  return json<T>(await api(token, path, init), `${init.method ?? 'GET'} ${path}`)
}

/** Post one write intent as a signed-in principal, with an optional operation time. */
async function postIntent(
  token: string,
  body: Record<string, unknown>,
  at: number = Date.now()
): Promise<Response> {
  return api(token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), at, ...body }),
  })
}

/** The ids of one inbox tab for one principal. */
async function inboxIds(token: string, tab: 'started' | 'my' | 'available'): Promise<string[]> {
  const items = await apiJson<readonly { readonly instanceId: string }[]>(
    token,
    `/api/v1/inbox?tab=${tab}`
  )
  return items.map((item) => item.instanceId)
}

/** The read of one instance as one principal. */
function readInstance(token: string, instanceId: string): Promise<InstanceView> {
  return apiJson<InstanceView>(token, `/api/v1/instances/${instanceId}`)
}

/** The outbox rows that the database holds. */
function outboxRows(): readonly OutboxRow[] {
  const { databaseUrl } = requireSetup()
  return queryDatabase(
    databaseUrl,
    `select effect, status, payload::text, coalesce(instance_id, '') from outbox order by created_at, seq`
  ).map((line) => {
    const [effect, status, payload, instanceId] = line.split('\t')
    return { effect, status, payload, instanceId }
  })
}

/** The messages that Mailpit holds. */
async function mailpitMessages(): Promise<readonly MailpitMessage[]> {
  const { config } = requireSetup()
  const response = await fetch(`${config.mailpitUrl}/api/v1/messages?limit=500`)
  if (!response.ok) throw new Error(`Mailpit answered ${response.status}: ${await response.text()}`)
  const body = (await response.json()) as { messages: readonly MailpitMessage[] }
  return body.messages
}

/** One Mailpit message with its bodies. */
async function mailpitMessage(id: string): Promise<MailpitMessageDetail> {
  const { config } = requireSetup()
  const response = await fetch(`${config.mailpitUrl}/api/v1/message/${id}`)
  if (!response.ok) throw new Error(`Mailpit answered ${response.status}: ${await response.text()}`)
  return (await response.json()) as MailpitMessageDetail
}

/** Empty Mailpit, so another run's messages cannot satisfy this test. */
async function clearMailpit(): Promise<void> {
  const { config } = requireSetup()
  await fetch(`${config.mailpitUrl}/api/v1/messages`, { method: 'DELETE' })
}

/** Wait for one condition, or fail with the reason that it never held. */
async function waitFor<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(250)
  }
  throw new Error(`integration: timed out waiting for ${what}`)
}

/** Start `enform worker` against the test configuration. */
function startWorker(configPath: string): WorkerChild {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), 'worker', '--config', configPath],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(10_000).then(() => child.kill('SIGKILL'))])
  }
  return { child, stop }
}

/** Advance a new demo instance from the request step to the registrar step. */
async function instanceAtRegistrar(tokens: {
  readonly sam: string
  readonly okafor: string
  readonly ana: string
}): Promise<string> {
  const slug = requireSetup().seed.flow?.slug ?? ''
  const instanceId = randomUUID()
  const start = await postIntent(tokens.sam, {
    type: 'instance.started@1',
    payload: {
      flow: slug,
      instanceId,
      values: { summary: 'A second overload request', credits: 2 },
    },
  })
  expect(start.status, await start.text()).toBe(201)

  const request = await readInstance(tokens.sam, instanceId)
  const claimRequest = await postIntent(tokens.sam, {
    type: 'step.claimed@1',
    payload: { instanceId, expectedVersion: request.version },
  })
  expect(claimRequest.status, await claimRequest.text()).toBe(201)
  const completeRequest = await postIntent(tokens.sam, {
    type: 'step.completed@1',
    payload: {
      instanceId,
      version: request.version + 1,
      outcome: 'submit',
      values: { summary: 'A second overload request', credits: 2 },
    },
  })
  expect(completeRequest.status, await completeRequest.text()).toBe(201)

  const advisor = await readInstance(tokens.okafor, instanceId)
  expect(advisor.status.currentStep, 'the request moves to the advisor').toBe('advisor')
  const claimAdvisor = await postIntent(tokens.okafor, {
    type: 'step.claimed@1',
    payload: { instanceId, expectedVersion: advisor.version },
  })
  expect(claimAdvisor.status, await claimAdvisor.text()).toBe(201)
  const completeAdvisor = await postIntent(tokens.okafor, {
    type: 'step.completed@1',
    payload: { instanceId, version: advisor.version + 1, outcome: 'approve', values: {} },
  })
  expect(completeAdvisor.status, await completeAdvisor.text()).toBe(201)

  const registrar = await readInstance(tokens.ana, instanceId)
  expect(registrar.status.currentStep, 'the instance reaches the registrar').toBe('registrar')
  // Ana claims two idle periods ago, so the step's one minute idle has passed
  // while the takeover itself still runs on the server clock (AS-3).
  const claim = await postIntent(
    tokens.ana,
    {
      type: 'step.claimed@1',
      payload: { instanceId, expectedVersion: registrar.version },
    },
    Date.now() - BACKDATED_CLAIM_MS
  )
  expect(claim.status, await claim.text()).toBe(201)
  return instanceId
}

test('#242 S10 Lee takes over Ana’s registrar task after the idle period, is refused before it, and Ana is notified', async () => {
  const { browser, config, publicUrl, seed, databaseUrl, configPath } = requireSetup()
  const slug = seed.flow?.slug ?? ''
  const ana = castMember('registrar')
  const lee = seed.users?.find((user) => user.role === 'registrar' && user.id !== ana.id)
  const sam = castMember('starter')
  const okafor = castMember('advisor')
  if (lee === undefined) throw new Error('the demo cast has no second registrar')
  await clearMailpit()

  // Every principal signs in once, so the worker can resolve Ana's email from
  // the principals projection when it sends the takeover email (SE-2).
  const anaToken = await passwordToken(config, ana.email, ana.password)
  const leeToken = await passwordToken(config, lee.email, lee.password)
  const samToken = await passwordToken(config, sam.email, sam.password)
  const okaforToken = await passwordToken(config, okafor.email, okafor.password)
  for (const token of [anaToken, leeToken, samToken, okaforToken]) {
    await readSession(publicUrl, token)
  }

  // 1. Ana claims the seeded registrar task in the browser. The holder is Ana
  // and the read offers her the step's outcomes (S09, AS-2, AC-4).
  const registrar = seededInstance('registrar')
  const anaContext = await browser.newContext()
  const anaPage = await anaContext.newPage()
  await signIn(anaPage, publicUrl, ana.email, ana.password)
  await anaPage.goto(taskUrl(registrar.id))
  await anaPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
  await anaPage.click('[data-claim]')
  await anaPage.locator('[data-outcome="approve"]').waitFor({ timeout: 30_000 })
  expect(await anaPage.textContent('.instance-status')).toContain(`holder ${ana.id}`)
  const held = await readInstance(anaToken, registrar.id)
  expect(held.status.holder).toBe(ana.id)
  expect(held.canTakeOver, 'the holder cannot take the task over from itself').toBe(false)

  // 2. Lee opens the task in a second context. The step allows an after-idle
  // takeover, but Ana claimed seconds ago, so the control is visible, disabled
  // and names the remaining idle time (S10, AS-3).
  const leeContext = await browser.newContext()
  const leePage = await leeContext.newPage()
  await signIn(leePage, publicUrl, lee.email, lee.password)
  await leePage.goto(taskUrl(registrar.id))
  await leePage.locator('[data-takeover-section]').waitFor({ timeout: 30_000 })
  const takeoverControl = leePage.locator('[data-takeover]')
  expect(await takeoverControl.isDisabled(), 'the idle period is still running').toBe(true)
  await leePage.locator('[data-takeover-wait]').waitFor({ timeout: 30_000 })
  expect(await leePage.textContent('[data-takeover-wait]')).toContain('left')

  const leeView = await readInstance(leeToken, registrar.id)
  expect(leeView.canTakeOver).toBe(true)
  expect(leeView.takeoverAvailableAt).toBe(held.takeoverAvailableAt ?? 0)
  expect(leeView.takeoverAvailableAt, 'the idle period ends in the future').toBeGreaterThan(
    Date.now()
  )
  expect(leeView.takeoverAvailableAt).toBeLessThanOrEqual(Date.now() + IDLE_MS)

  // The server refuses the early takeover with the remaining time, and the
  // attempt appends nothing (AS-3, I1).
  const early = await postIntent(leeToken, {
    type: 'step.taken-over@1',
    payload: { instanceId: registrar.id, reason: REASON, version: leeView.version },
  })
  const earlyBody = await early.text()
  expect(early.status, earlyBody).toBe(409)
  expect(earlyBody).toContain('ms more')

  // A principal that is not an assignee of the step cannot take it over, even
  // with the current version (AS-3, I8).
  const outsider = await postIntent(samToken, {
    type: 'step.taken-over@1',
    payload: { instanceId: registrar.id, reason: REASON, version: leeView.version },
  })
  const outsiderBody = await outsider.text()
  expect(outsider.status, outsiderBody).toBe(403)
  expect(outsiderBody).toContain('not an assignee')

  // A raw resolved takeover is refused instead of reaching the log (ADR 0010).
  const raw = await postIntent(leeToken, {
    type: 'step.taken-over@1',
    payload: { instanceId: registrar.id, step: 'registrar', from: ana.id, to: lee.id },
  })
  expect(raw.status, await raw.text()).toBe(400)

  let log = await apiJson<readonly Event[]>(leeToken, '/api/v1/log')
  expect(
    log.filter(
      (event) => event.type === 'step.taken-over@1' && event.payload.instanceId === registrar.id
    ),
    'the refused attempts appended no takeover'
  ).toEqual([])

  // 3. A second registrar instance is claimed as Ana two idle periods ago, so
  // Lee's browser takeover succeeds and the page shows the new holder and the
  // reason (S10, AS-3, WF-5).
  const takenId = await instanceAtRegistrar({
    sam: samToken,
    okafor: okaforToken,
    ana: anaToken,
  })
  const beforeTakeover = await readInstance(leeToken, takenId)
  expect(beforeTakeover.status.holder).toBe(ana.id)
  expect(beforeTakeover.canTakeOver).toBe(true)
  expect(beforeTakeover.takeoverAvailableAt, 'the idle period has passed').toBeLessThan(Date.now())

  await leePage.goto(taskUrl(takenId))
  await leePage.locator('[data-takeover-section]').waitFor({ timeout: 30_000 })
  const ready = leePage.locator('[data-takeover]')
  expect(await ready.isDisabled(), 'the idle period has passed').toBe(false)
  await leePage.fill('[data-takeover-reason]', REASON)
  await ready.click()
  await leePage.locator('.status', { hasText: 'Taken over:' }).waitFor({ timeout: 30_000 })
  await leePage.waitForFunction(
    (holder) => document.querySelector('.instance-status')?.textContent?.includes(holder),
    lee.id,
    { timeout: 30_000 }
  )
  expect(await leePage.textContent('.status')).toContain(REASON)
  expect(await leePage.locator('[data-takeover-section]').count(), 'Lee holds the task').toBe(0)

  const afterTakeover = await readInstance(leeToken, takenId)
  expect(afterTakeover.status.holder).toBe(lee.id)
  expect(await inboxIds(anaToken, 'my'), 'the task left Ana’s inbox').not.toContain(takenId)
  expect(await inboxIds(leeToken, 'my'), 'the task entered Lee’s inbox').toContain(takenId)

  // 4. The worker delivers the takeover notification to the previous holder.
  // Mailpit shows the reason and the link to the task (SE-2, I2).
  const worker = startWorker(configPath)
  const message = await waitFor('the takeover email', async () => {
    const messages = await mailpitMessages()
    return messages.find(
      (candidate) =>
        candidate.Subject.includes('task taken over (registrar)') &&
        candidate.To.some((to) => to.Address === ana.email)
    )
  })
  const detail = await mailpitMessage(message.ID)
  await worker.stop()
  expect(detail.Text).toContain(REASON)
  expect(detail.Text).toContain(
    `${publicUrl}/app/?flow=${encodeURIComponent(slug)}&instance=${encodeURIComponent(takenId)}`
  )
  const notification = outboxRows().find(
    (row) => row.effect === 'send-takeover' && row.instanceId === takenId
  )
  expect(notification?.status, 'the takeover row is delivered').toBe('sent')
  expect(notification?.payload).toContain(ana.id)

  // 5. The log keeps the attributed takeover with from, to, when and why, and
  // a rebuild reproduces the holder in both projections (I4, I5, I14).
  log = await apiJson<readonly Event[]>(leeToken, '/api/v1/log')
  const takeoverEvents = log.filter(
    (event) => event.type === 'step.taken-over@1' && event.payload.instanceId === takenId
  )
  expect(takeoverEvents).toHaveLength(1)
  expect(takeoverEvents[0]).toMatchObject({
    actor: lee.id,
    payload: {
      instanceId: takenId,
      step: 'registrar',
      from: ana.id,
      to: lee.id,
      why: REASON,
    },
  })
  expect(takeoverEvents[0]?.payload.when).toBeTypeOf('number')

  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  const rebuiltView = await readInstance(leeToken, takenId)
  expect(rebuiltView.status.holder, 'the rebuilt instance keeps the new holder').toBe(lee.id)
  expect(
    queryDatabase(databaseUrl, `select holder from instances where id = '${takenId}'`)[0]
  ).toBe(lee.id)
  expect(
    queryDatabase(
      databaseUrl,
      `select holder from tasks where instance_id = '${takenId}' and step = 'registrar'`
    )[0]
  ).toBe(lee.id)
  expect(
    queryDatabase(databaseUrl, `select holder from instances where id = '${registrar.id}'`)[0],
    'the seeded instance keeps the holder it had'
  ).toBe(ana.id)
  expect(await inboxIds(leeToken, 'my'), 'the rebuilt inbox holds the task').toContain(takenId)
}, 240_000)
