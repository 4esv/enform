import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, passwordToken } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #238, S13, WF-4, WF-5, AC-5, I4, I5, I8, I14: the withdraw, cancel
// and undo journey against the real Compose stack. `enform seed demo` loads the
// demo cast, the flow with a 24 hour undo period, and four in-flight instances.
// Sam withdraws his own request and undoes it; Priya, who holds
// `instance.cancel` on the demo flow, cancels one instance and undoes it. A
// principal without `instance.cancel` is refused, a stale undo is refused, and
// the log keeps the attributed close and undo events. The test drives the app's
// own controls and waits on them, never on a fixed timeout.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `withdraw-admin-${RUN}@test.local`
const ADMIN_PASSWORD = '<redacted by permission-gate>'
const REPO = join(import.meta.dirname, '..')
const WITHDRAW_REASON = 'Dropped a class'
const CANCEL_REASON = 'Already submitted as #4411'

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
  readonly type: string
  readonly actor?: string
  readonly payload: Record<string, unknown>
}

/** One inbox item as `GET /api/v1/inbox` returns it. */
type InboxItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
}

/** One instance view as `GET /api/v1/instances/{id}` returns it. */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: { readonly currentStep?: string; readonly state: string }
  readonly withdrawal?: string
  readonly closeReason?: string
  readonly closedAt?: number
  readonly closedBy?: string
  readonly undoUntil?: number
  readonly canWithdraw: boolean
  readonly canCancel: boolean
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
    const dir = mkdtempSync(join(tmpdir(), 'enform-withdraw-'))
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

/** Post one write intent as a signed-in principal. */
async function postIntent(token: string, body: Record<string, unknown>): Promise<Response> {
  return api(token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), at: Date.now(), ...body }),
  })
}

/** The ids of one inbox tab for one principal. */
async function inboxIds(token: string, tab: 'started' | 'my' | 'available'): Promise<string[]> {
  const items = await apiJson<readonly InboxItem[]>(token, `/api/v1/inbox?tab=${tab}`)
  return items.map((item) => item.instanceId)
}

test('#238 S13 Sam withdraws and undoes, Priya cancels and undoes, and the log keeps both', async () => {
  const { browser, config, publicUrl, seed, databaseUrl, configPath } = requireSetup()
  const slug = seed.flow?.slug ?? ''
  const sam = castMember('starter')
  const priya = castMember('reader')
  const request = seededInstance('request')
  const registrar = seededInstance('registrar')
  const samToken = await passwordToken(config, sam.email, sam.password)
  const priyaToken = await passwordToken(config, priya.email, priya.password)
  const taskUrl = (instanceId: string): string =>
    `${publicUrl}/?flow=${encodeURIComponent(slug)}&instance=${encodeURIComponent(instanceId)}`

  // 1. Sam opens his request and withdraws it with a reason. The read decides
  // that he may withdraw, and the engine closes the task (S13, WF-4, AC-5).
  const samContext = await browser.newContext()
  const samPage = await samContext.newPage()
  await signIn(samPage, publicUrl, sam.email, sam.password)
  await samPage.goto(taskUrl(request.id))
  await samPage.locator('[data-withdraw]').waitFor({ timeout: 30_000 })
  expect(await samPage.locator('[data-cancel]').count(), 'Sam holds no instance.cancel').toBe(0)
  await samPage.fill('[data-withdraw-reason]', WITHDRAW_REASON)
  await samPage.click('[data-withdraw]')
  await samPage.locator('[data-close][data-withdrawal="withdrawn"]').waitFor({ timeout: 30_000 })
  expect(await samPage.textContent('.close h2')).toBe('Withdrawn')
  expect(await samPage.textContent('[data-close-by]')).toContain(sam.id)
  expect(await samPage.textContent('[data-close-reason]')).toContain(WITHDRAW_REASON)
  await samPage.locator('[data-undo]').waitFor({ timeout: 30_000 })
  expect(await samPage.locator('[data-claim]').count(), 'the form is gone').toBe(0)
  expect(await samPage.locator('[data-outcome]').count(), 'no outcome is offered').toBe(0)

  // The inbox follows the projection: a closed instance is absent from
  // Started by me (VT-1, I4).
  expect(await inboxIds(samToken, 'started'), 'the closed request leaves the inbox').not.toContain(
    request.id
  )

  const closed = await apiJson<InstanceView>(samToken, `/api/v1/instances/${request.id}`)
  expect(closed.withdrawal).toBe('withdrawn')
  expect(closed.closedBy).toBe(sam.id)
  expect(closed.closeReason).toBe(WITHDRAW_REASON)
  expect(closed.undoUntil, 'the flow sets 24 hours').toBe((closed.closedAt ?? 0) + 24 * 3_600_000)

  // 2. Sam undoes the withdrawal. The task returns at the request step, the
  // close marker is gone, and the inbox shows the instance again (WF-5, I4).
  await samPage.click('[data-undo]')
  await samPage.waitForFunction(
    () => document.querySelector('.instance-status')?.textContent?.includes('Step 2 of 4'),
    undefined,
    { timeout: 30_000 }
  )
  await samPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
  expect(await samPage.locator('[data-close]').count(), 'the close marker is gone').toBe(0)
  expect(await inboxIds(samToken, 'started'), 'the reopened request is back').toContain(request.id)

  // 3. Priya holds instance.cancel on the demo flow, so she cancels the
  // registrar instance with a required reason (S13, WF-4, AC-1, AC-5).
  const priyaContext = await browser.newContext()
  const priyaPage = await priyaContext.newPage()
  await signIn(priyaPage, publicUrl, priya.email, priya.password)
  await priyaPage.goto(taskUrl(registrar.id))
  await priyaPage.locator('[data-cancel]').waitFor({ timeout: 30_000 })
  expect(await priyaPage.locator('[data-withdraw]').count(), 'Priya is not the starter').toBe(0)
  await priyaPage.fill('[data-cancel-reason]', CANCEL_REASON)
  await priyaPage.click('[data-cancel]')
  await priyaPage.locator('[data-close][data-withdrawal="cancelled"]').waitFor({ timeout: 30_000 })
  expect(await priyaPage.textContent('.close h2')).toBe('Cancelled')
  expect(await priyaPage.textContent('[data-close-by]')).toContain(priya.id)
  expect(await priyaPage.textContent('[data-close-reason]')).toContain(CANCEL_REASON)
  await priyaPage.locator('[data-undo]').waitFor({ timeout: 30_000 })

  // The projection records the close and its columns (I4, I5).
  expect(
    queryDatabase(
      databaseUrl,
      `select withdrawal, closed_by from instances where id = '${registrar.id}'`
    )[0]
  ).toBe(`cancelled\t${priya.id}`)

  // 4a. A principal without instance.cancel cannot cancel. Sam starts the
  // advisor instance and reads it, but the engine refuses his cancel (403).
  const advisor = seededInstance('advisor')
  const samView = await apiJson<InstanceView>(samToken, `/api/v1/instances/${advisor.id}`)
  expect(samView.canCancel, 'Sam does not hold instance.cancel').toBe(false)
  const forbidden = await postIntent(samToken, {
    type: 'instance.cancelled@1',
    actor: sam.id,
    payload: { instanceId: advisor.id, reason: 'not mine to cancel', version: samView.version },
  })
  expect(forbidden.status, await forbidden.text()).toBe(403)

  // 4b. A stale undo is refused (I5): the version before the close cannot
  // reopen it, and nothing is appended.
  const cancelled = await apiJson<InstanceView>(priyaToken, `/api/v1/instances/${registrar.id}`)
  const stale = await postIntent(priyaToken, {
    type: 'instance.undone@1',
    actor: priya.id,
    payload: { instanceId: registrar.id, version: Math.max(0, cancelled.version - 1) },
  })
  expect(stale.status, await stale.text()).toBe(409)

  // Priya undoes the cancellation; the task returns at the registrar step.
  await priyaPage.click('[data-undo]')
  await priyaPage.waitForFunction(
    () => document.querySelector('.instance-status')?.textContent?.includes('Step 4 of 4'),
    undefined,
    { timeout: 30_000 }
  )
  await priyaPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
  expect(await priyaPage.locator('[data-close]').count(), 'the cancel marker is gone').toBe(0)
  expect(
    queryDatabase(
      databaseUrl,
      `select coalesce(withdrawal, 'none'), coalesce(closed_at::text, 'none') from instances where id = '${registrar.id}'`
    )[0],
    'the undo clears the close columns'
  ).toBe('none\tnone')

  // 4c. The log keeps the close and the undo events with their actors (I4,
  // I14), and the refused cancel appended nothing.
  const log = await apiJson<readonly Event[]>(samToken, '/api/v1/log')
  const forInstance = (type: string, instanceId: string): readonly Event[] =>
    log.filter((event) => event.type === type && event.payload.instanceId === instanceId)

  expect(forInstance('instance.withdrawn@1', request.id)).toMatchObject([
    {
      actor: sam.id,
      payload: { instanceId: request.id, step: 'request', reason: WITHDRAW_REASON },
    },
  ])
  expect(forInstance('instance.undone@1', request.id)).toMatchObject([
    { actor: sam.id, payload: { instanceId: request.id, undoOf: 'withdrawn', step: 'request' } },
  ])
  expect(forInstance('instance.cancelled@1', registrar.id)).toMatchObject([
    {
      actor: priya.id,
      payload: { instanceId: registrar.id, step: 'registrar', reason: CANCEL_REASON },
    },
  ])
  expect(forInstance('instance.undone@1', registrar.id)).toMatchObject([
    {
      actor: priya.id,
      payload: { instanceId: registrar.id, undoOf: 'cancelled', step: 'registrar' },
    },
  ])
  expect(
    forInstance('instance.cancelled@1', advisor.id),
    'the refused cancel appended nothing'
  ).toEqual([])
  expect(
    forInstance('instance.withdrawn@1', request.id),
    'the withdrawal stays on the log after its undo (I4)'
  ).toHaveLength(1)

  // A rebuild folds the close and the undo back into the projection, so both
  // instances stay open where the undo restored them (I4, I5).
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  const requestAfter = await apiJson<InstanceView>(samToken, `/api/v1/instances/${request.id}`)
  expect(requestAfter.status.currentStep, 'the rebuilt request is open').toBe('request')
  expect(requestAfter.withdrawal).toBeUndefined()
  const registrarAfter = await apiJson<InstanceView>(
    priyaToken,
    `/api/v1/instances/${registrar.id}`
  )
  expect(registrarAfter.status.currentStep, 'the rebuilt registrar task is open').toBe('registrar')
  expect(await inboxIds(samToken, 'started'), 'the rebuilt instances return to the inbox').toEqual(
    expect.arrayContaining([request.id, registrar.id])
  )
}, 180_000)
