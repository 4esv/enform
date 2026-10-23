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

// Issue #246, S15, VT-2, VT-5, VT-6, I4, I8, I12: the instance timeline, the
// global change feed and the tracker times against the real Compose stack and
// the demo seed. The timeline is a projection of the append-only log (I4): the
// engine maps the entries and the server filters and authorizes them. The
// instance timeline carries the instance's own events in log order and, with
// `instance.timeline` on the flow, the flow's configuration changes; the global
// feed filters by flow and by type and refuses a requester without the scope
// (I8). Chromium reads the timeline and the tracker times, then toggles the
// configuration changes as Priya, who holds `instance.timeline`.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `timeline-admin-${RUN}@test.local`
const ADMIN_PASSWORD = `timeline-admin-${RUN}`
const REPO = join(import.meta.dirname, '..')
const COMMENT = 'Attach your degree audit'
const PUBLISHED = 'config.definition.published@1'
const SENT_BACK = 'step.sent-back@1'

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

/** One event as `GET /api/v1/log` returns it. */
type Event = {
  readonly seq: number
  readonly type: string
  readonly at: number
  readonly actor?: string
  readonly payload: Record<string, unknown>
}

/** One entry as the timeline endpoints return it. */
type TimelineEntry = {
  readonly seq: number
  readonly at: number
  readonly actor?: string
  readonly type: string
  readonly flow?: string
  readonly step?: string
  readonly comment?: string
  readonly call?: { readonly operation: string; readonly time: number; readonly outcome: string }
}

/** One tracker entry of the instance read. */
type TrackerStep = {
  readonly key: string
  readonly state: string
  readonly holder?: string
  readonly condition?: unknown
  readonly comment?: string
  readonly startAt?: number
  readonly lastActivityAt?: number
}

/** The instance read as one actor sees it. */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: { readonly currentStep?: string; readonly holder?: string }
  readonly tracker: readonly TrackerStep[]
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

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-timeline-'))
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

/** Fetch one API path with a bearer principal. */
async function getAs(token: string, path: string): Promise<Response> {
  const { publicUrl } = requireSetup()
  return fetch(`${publicUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Read one API path as a bearer principal, or name the request that failed. */
async function getJsonAs<T>(token: string, path: string): Promise<T> {
  return json<T>(await getAs(token, path), `GET ${path}`)
}

/** Read the log as a bearer principal. */
async function readLogAs(token: string): Promise<readonly Event[]> {
  return getJsonAs<readonly Event[]>(token, '/api/v1/log')
}

/** Read one instance as a bearer principal. */
async function readAs(token: string, instanceId: string): Promise<InstanceView> {
  return getJsonAs<InstanceView>(token, `/api/v1/instances/${instanceId}`)
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

/** The event of one type that names one instance, or the reason the log lacks it. */
function eventOf(log: readonly Event[], type: string, instanceId: string): Event {
  const event = log.find(
    (candidate) => candidate.type === type && candidate.payload.instanceId === instanceId
  )
  if (event === undefined) throw new Error(`the log has no ${type} for ${instanceId}`)
  return event
}

/** The tracker step of one key, or the reason the read lacks it. */
function trackerStep(view: InstanceView, key: string): TrackerStep {
  const step = view.tracker.find((candidate) => candidate.key === key)
  if (step === undefined) throw new Error(`the tracker has no ${key}`)
  return step
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

test('#246 S15 VT-5 the timeline is the instance own events in log order', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const token = await passwordToken(config, sam.email, sam.password)
  const advisor = demoInstance((instance) => instance.step === 'advisor')
  const request = demoInstance((instance) => instance.step === 'request')
  const log = await readLogAs(token)

  const entries = await getJsonAs<readonly TimelineEntry[]>(
    token,
    `/api/v1/instances/${advisor.id}/timeline`
  )
  // The second demo instance was started, claimed, completed at `request` and
  // submitted, in that order (I4). The skip of the chair step rides on the
  // start event, and the tracker reports it with its condition.
  expect(entries.map((entry) => entry.type)).toEqual([
    'instance.started@1',
    'step.claimed@1',
    'step.completed@1',
    'instance.submitted@1',
  ])
  expect(entries.map((entry) => entry.seq)).toEqual(
    log.filter((event) => event.payload.instanceId === advisor.id).map((event) => event.seq)
  )
  expect(entries.map((entry) => entry.actor)).toEqual([sam.id, sam.id, sam.id, sam.id])
  for (let index = 1; index < entries.length; index += 1) {
    expect(entries[index].at).toBeGreaterThanOrEqual(entries[index - 1].at)
  }

  // Another instance's events never reach this timeline (I4): the request
  // instance above has only its start, while the advisor instance has four.
  const firstEntries = await getJsonAs<readonly TimelineEntry[]>(
    token,
    `/api/v1/instances/${request.id}/timeline`
  )
  expect(firstEntries.map((entry) => entry.type)).toEqual(['instance.started@1'])
  expect(firstEntries.map((entry) => entry.seq)).toEqual(
    log.filter((event) => event.payload.instanceId === request.id).map((event) => event.seq)
  )

  // The tracker's start and last activity are the logged entry and the newest
  // event for the step (VT-2).
  const view = await readAs(token, advisor.id)
  const started = eventOf(log, 'instance.started@1', advisor.id)
  const completed = eventOf(log, 'step.completed@1', advisor.id)
  expect(trackerStep(view, 'request')).toEqual({
    key: 'request',
    state: 'completed',
    startAt: started.at,
    lastActivityAt: completed.at,
  })
  expect(trackerStep(view, 'advisor')).toEqual({
    key: 'advisor',
    state: 'unopened',
    startAt: completed.at,
  })
  expect(view.tracker.find((step) => step.key === 'chair')).toEqual({
    key: 'chair',
    state: 'skipped',
    condition: CHAIR_CONDITION,
  })
}, 180_000)

test('#246 I8 the configuration changes need instance.timeline on the flow', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const priya = castMember('reader')
  const request = demoInstance((instance) => instance.step === 'request')
  const samToken = await passwordToken(config, sam.email, sam.password)
  const priyaToken = await passwordToken(config, priya.email, priya.password)

  const own = await getJsonAs<readonly TimelineEntry[]>(
    samToken,
    `/api/v1/instances/${request.id}/timeline`
  )
  expect(
    own.some((entry) => entry.type.startsWith('config.')),
    'Sam sees no configuration change'
  ).toBe(false)

  const refused = await getAs(samToken, `/api/v1/instances/${request.id}/timeline?includeChanges=1`)
  expect(refused.status, 'Sam lacks instance.timeline on the flow').toBe(403)

  const withChanges = await getJsonAs<readonly TimelineEntry[]>(
    priyaToken,
    `/api/v1/instances/${request.id}/timeline?includeChanges=1`
  )
  const publication = withChanges.find((entry) => entry.type === PUBLISHED)
  expect(publication, 'Priya holds instance.timeline and reads the publication').toBeDefined()
  expect(publication?.flow).toBe(flowSlug())
  const started = withChanges.find((entry) => entry.type === 'instance.started@1')
  expect(publication?.seq, 'the configuration change keeps the log order').toBeLessThan(
    started?.seq ?? 0
  )
  expect(
    withChanges.some((entry) => entry.type.startsWith('config.')),
    'the flow changes are present'
  ).toBe(true)
}, 180_000)

test('#246 VT-6 the change feed filters by flow and type and refuses a requester', async () => {
  const { config } = requireSetup()
  const sam = castMember('starter')
  const priya = castMember('reader')
  const slug = flowSlug()
  const samToken = await passwordToken(config, sam.email, sam.password)
  const priyaToken = await passwordToken(config, priya.email, priya.password)
  const path = `/api/v1/timeline?flow=${encodeURIComponent(slug)}&type=${encodeURIComponent(PUBLISHED)}`

  const entries = await getJsonAs<readonly TimelineEntry[]>(priyaToken, path)
  expect(entries.length, 'the demo flow has its publication').toBeGreaterThan(0)
  expect(entries.every((entry) => entry.type === PUBLISHED)).toBe(true)
  expect(entries.every((entry) => entry.flow === slug)).toBe(true)
  for (let index = 1; index < entries.length; index += 1) {
    expect(entries[index].seq).toBeGreaterThan(entries[index - 1].seq)
  }

  const refused = await getAs(samToken, path)
  expect(refused.status, 'Sam holds neither instance.timeline nor org.grants').toBe(403)

  // Without the flow filter the feed still needs the organization scope.
  expect((await getAs(samToken, '/api/v1/timeline')).status).toBe(403)
}, 180_000)

test('#246 S15 WF-3 a send back enters the timeline and moves the tracker times', async () => {
  const { config, configPath } = requireSetup()
  const sam = castMember('starter')
  const okafor = castMember('advisor')
  const advisor = demoInstance((instance) => instance.step === 'advisor')
  const samToken = await passwordToken(config, sam.email, sam.password)
  const okaforToken = await passwordToken(config, okafor.email, okafor.password)

  const before = await readAs(okaforToken, advisor.id)
  const claim = await postIntent(okaforToken, {
    id: randomUUID(),
    type: 'step.claimed@1',
    at: Date.now(),
    actor: okafor.id,
    payload: { instanceId: advisor.id, expectedVersion: before.version },
  })
  expect(claim.status, await claim.text()).toBe(201)

  const held = await readAs(okaforToken, advisor.id)
  const sent = await postIntent(okaforToken, {
    id: randomUUID(),
    type: SENT_BACK,
    at: Date.now(),
    actor: okafor.id,
    payload: {
      instanceId: advisor.id,
      to: 'request',
      comment: COMMENT,
      version: held.version,
    },
  })
  expect(sent.status, await sent.text()).toBe(201)

  const entries = await getJsonAs<readonly TimelineEntry[]>(
    samToken,
    `/api/v1/instances/${advisor.id}/timeline`
  )
  const sentBack = entries.find((entry) => entry.type === SENT_BACK)
  expect(sentBack).toMatchObject({ step: 'request', comment: COMMENT, actor: okafor.id })
  expect(entries[entries.length - 1]?.seq, 'the send back is the newest entry').toBe(sentBack?.seq)

  const log = await readLogAs(samToken)
  const completed = eventOf(log, 'step.completed@1', advisor.id)
  const view = await readAs(samToken, advisor.id)
  expect(trackerStep(view, 'request')).toEqual({
    key: 'request',
    state: 'sent-back',
    comment: COMMENT,
    startAt: sentBack?.at,
    lastActivityAt: sentBack?.at,
  })
  expect(trackerStep(view, 'advisor')).toEqual({
    key: 'advisor',
    state: 'opened',
    startAt: completed.at,
    lastActivityAt: sentBack?.at,
  })

  // A rebuild reproduces the same projection from the same events (I4).
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  const after = await getJsonAs<readonly TimelineEntry[]>(
    samToken,
    `/api/v1/instances/${advisor.id}/timeline`
  )
  expect(after, 'the rebuild leaves the timeline unchanged').toEqual(entries)
}, 180_000)

test('#246 S15 VT-5 Chromium shows the timeline, the tracker times and the toggle', async () => {
  const { browser, publicUrl, config } = requireSetup()
  const priya = castMember('reader')
  const request = demoInstance((instance) => instance.step === 'request')
  const sam = castMember('starter')
  const token = await passwordToken(config, sam.email, sam.password)
  const log = await readLogAs(token)
  const startedAt = eventOf(log, 'instance.started@1', request.id).at
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signIn(page, publicUrl, priya.email, priya.password)
    await page.goto(
      `${publicUrl}/?flow=${encodeURIComponent(flowSlug())}&instance=${encodeURIComponent(request.id)}`
    )
    await page.locator('[data-timeline]').waitFor({ timeout: 30_000 })
    await expect.poll(async () => page.locator('[data-timeline-seq]').count()).toBe(1)
    expect(
      await page.locator('[data-timeline-type="instance.started@1"]').count(),
      'the start is the only instance event'
    ).toBe(1)

    const startTime = await page
      .locator('[data-tracker-step="request"] [data-tracker-start]')
      .getAttribute('datetime')
    expect(startTime).toBe(new Date(startedAt).toISOString())

    // Priya holds instance.timeline, so the toggle loads the flow's changes
    // beside the instance's own events (VT-5).
    await page.locator('[data-timeline-changes]').check()
    await page.locator(`[data-timeline-type="${PUBLISHED}"]`).waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-timeline-type="instance.started@1"]').count()).toBe(1)
    await expect.poll(async () => page.locator('[data-timeline-seq]').count()).toBeGreaterThan(1)
  } finally {
    await context.close()
  }
}, 120_000)
