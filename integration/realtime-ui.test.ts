import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #260, RT-1, RT-2, A4, S09: the realtime interface in Chromium. Sam
// opens his request: the header shows the transport mode, Live on the
// WebSocket. Dr. Okafor opens the same request in another browser context
// and both pages name each other as present. Okafor claims the task through
// the API, and Sam's page re-reads it: the advisor step shows as opened
// without a reload.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `realtime-ui-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'realtime-ui-admin-password'
const REPO = join(import.meta.dirname, '..')

type DemoUser = {
  readonly role: string
  readonly email: string
  readonly id: string
  readonly password: string
  readonly displayName?: string
}

type DemoInstance = { readonly id: string; readonly step: string; readonly done: boolean }

type SeedOutput = {
  readonly flow?: { readonly slug: string }
  readonly users?: readonly DemoUser[]
  readonly instances?: readonly DemoInstance[]
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
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
    const dir = mkdtempSync(join(tmpdir(), 'enform-realtime-ui-'))
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
    const seeded = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(REPO, 'cli', 'main.ts'),
        'seed',
        'demo',
        '--config',
        configPath,
        '--json',
      ],
      { cwd: REPO, encoding: 'utf8' }
    )
    if (seeded.status !== 0) throw new Error(`the demo seed failed: ${seeded.stderr}`)
    const browser = await chromium.launch()
    setup = { config, dir, publicUrl, service, browser, seed: JSON.parse(seeded.stdout) }
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  await setup?.browser.close()
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

function demoUser(role: string): DemoUser {
  const user = requireSetup().seed.users?.find((entry) => entry.role === role)
  if (user === undefined) throw new Error(`the seed has no ${role} user`)
  return user
}

/** Sign in through the identity provider's page, then wait for the shell. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  const { publicUrl } = requireSetup()
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

test('#260 RT-1 RT-2 the page shows Live, names the other viewer, and re-reads a change made elsewhere', async () => {
  const { browser, publicUrl, seed, config } = requireSetup()
  const sam = demoUser('starter')
  const okafor = demoUser('advisor')
  const slug = seed.flow?.slug
  const request = seed.instances?.find((entry) => entry.step === 'advisor')
  if (slug === undefined || request === undefined)
    throw new Error('the seed has no advisor request')
  const url = `${publicUrl}/?flow=${encodeURIComponent(slug)}&instance=${encodeURIComponent(request.id)}`

  const samContext = await browser.newContext()
  const okaforContext = await browser.newContext()
  try {
    const samPage = await samContext.newPage()
    await signIn(samPage, sam.email, sam.password)
    await samPage.goto(url)
    // The transport mode is visible, and the WebSocket rung is Live (RT-1).
    const connection = samPage.locator('[data-connection]')
    await connection.waitFor({ timeout: 30_000 })
    await samPage.waitForFunction(
      () => document.querySelector('[data-connection]')?.getAttribute('data-mode') === 'live',
      undefined,
      { timeout: 30_000 }
    )
    expect(await connection.textContent()).toBe('Live')

    // Dr. Okafor opens the same request: each page names the other (RT-2).
    const okaforPage = await okaforContext.newPage()
    await signIn(okaforPage, okafor.email, okafor.password)
    await okaforPage.goto(url)
    await okaforPage.waitForFunction(
      () => document.querySelector('[data-connection]')?.getAttribute('data-mode') === 'live',
      undefined,
      { timeout: 30_000 }
    )
    await samPage.waitForFunction(
      () => (document.querySelector('[data-presence]')?.textContent ?? '').includes('Also here'),
      undefined,
      { timeout: 30_000 }
    )
    expect(await samPage.locator('[data-presence]').textContent()).toContain('Okafor')
    await okaforPage.waitForFunction(
      () => (document.querySelector('[data-presence]')?.textContent ?? '').includes('Also here'),
      undefined,
      { timeout: 30_000 }
    )
    expect(await okaforPage.locator('[data-presence]').textContent()).toContain('Sam')

    // Okafor claims through the API: Sam's page re-reads it without a reload,
    // and the advisor step shows as opened (A4, S09).
    const token = await passwordToken(config, okafor.email, okafor.password)
    const view = await fetch(`${publicUrl}/api/v1/instances/${request.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const { version } = (await view.json()) as { version: number }
    const claimed = await fetch(`${publicUrl}/api/v1/operations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: randomUUID(),
        type: 'step.claimed@1',
        at: Date.now(),
        actor: okafor.id,
        payload: { instanceId: request.id, expectedVersion: version },
      }),
    })
    expect(claimed.status, await claimed.clone().text()).toBe(201)
    await samPage
      .locator('[data-tracker-step="advisor"][data-tracker-state="opened"]')
      .waitFor({ timeout: 30_000 })
  } finally {
    await samContext.close()
    await okaforContext.close()
  }
}, 180_000)
