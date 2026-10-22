import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #224, #218, ID-6, DE-1, DE-3, DX-1, DX-4, DF-1, DF-4, DF-5, FM-1,
// FM-3, I12, ADR 0009, ADR 0012: the production interface against the real
// Compose stack. `enform init` serves the app at the configured URL; Chromium
// follows the Keycloak sign-in, lands on the empty get-started page, creates a
// flow, builds one field and a second step in the builder, saves, publishes,
// grants the outcomes and opens the form. The test then starts the instance
// and asserts the link that the page shows.
//
// The Keycloak login page is the only variable outside the server, so the test
// waits on the app's own heading and controls, never on a fixed timeout.

const RUN = randomUUID().slice(0, 8)
const SLUG = `browser-${RUN}`
const TITLE = `Browser flow ${RUN}`
const ADMIN_EMAIL = `browser-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'browser-admin-password'

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly browser: Browser
  readonly page: Page
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-interface-'))
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
    const browser = await chromium.launch()
    const page = await browser.newPage()
    setup = { config, dir, publicUrl, service, browser, page }
  } catch (error) {
    setupError = error
  }
}, 120_000)

afterAll(async () => {
  await setup?.browser.close()
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

function requireSetup(): Setup {
  if (setup === undefined) {
    throw setupError ?? new Error('integration: the interface setup did not run')
  }
  return setup
}

/** Sign in on the Keycloak page and wait for the app's own heading. */
async function signIn(page: Page, publicUrl: string): Promise<void> {
  await page.goto(publicUrl)
  await page.locator('#username').waitFor({ timeout: 30_000 })
  await page.fill('#username', ADMIN_EMAIL)
  await page.fill('#password', ADMIN_PASSWORD)
  await page.click('#kc-login')
  await page.getByRole('heading', { name: 'Build your first flow' }).waitFor({
    timeout: 30_000,
  })
}

test('#224 a person signs in, builds a flow, publishes it and opens the form', async () => {
  const { page, publicUrl } = requireSetup()
  await signIn(page, publicUrl)

  await page.fill('#flow-slug', SLUG)
  await page.fill('#flow-title', TITLE)
  await page.getByRole('button', { name: 'Create your first flow' }).click()

  // The builder loads the draft that the creation pushed: one starter step.
  await page.locator('[data-add-step]').waitFor({ timeout: 30_000 })
  expect(await page.textContent('[data-builder-title]')).toBe(TITLE)
  expect(await page.locator('[data-step-index="0"]').count()).toBe(1)

  // One text field on the first step.
  await page.click('[data-step-index="0"] [data-add-field="0"]')
  await page.fill('[data-step-index="0"] [data-field-index="0"] [data-field-key]', 'summary')
  await page.fill('[data-step-index="0"] [data-field-index="0"] [data-field-label]', 'Summary')

  // A second step makes the first one a middle approval step.
  await page.click('[data-add-step]')
  await page.locator('[data-step-index="1"]').waitFor()
  await page.fill('[data-step-index="1"] [data-step-key]', 'approve')

  await page.click('[data-save]')
  await page.waitForFunction(() =>
    document.querySelector('[data-builder-status]')?.textContent?.startsWith('Saved')
  )

  await page.click('[data-publish]')
  await page.waitForFunction(() =>
    document.querySelector('[data-published]')?.textContent?.includes('Published version 1')
  )
  const published = await page.textContent('[data-published]')
  expect(published, 'the content hash prefix shows').toMatch(/content [0-9a-f]{8}$/)

  // The grant control posts config.grant.changed@1 through the write path.
  await page.click('[data-grant="0"]')
  await page.waitForFunction(() =>
    document.querySelector('[data-builder-status]')?.textContent?.startsWith('Granted')
  )

  // Open the published form. The first field renders.
  await page.goto(`${publicUrl}/?flow=${SLUG}`)
  const summary = page.locator('input[name="summary"]')
  await summary.waitFor({ timeout: 30_000 })
  expect(await summary.isVisible()).toBe(true)
  expect(await summary.isDisabled(), 'the builder makes the field editable').toBe(false)
  await summary.fill('First request')

  // Start the instance and follow the link the page shows.
  await page.click('[data-start]')
  const link = page.locator('.instance-link a')
  await link.waitFor({ timeout: 30_000 })
  const href = await link.getAttribute('href')
  expect(href, 'the link names the instance').toContain('instance=')
  expect(await link.textContent(), 'the link shows the instance id').toBeTruthy()
}, 120_000)
