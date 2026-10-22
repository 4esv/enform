import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createUser, keycloakAdminToken, passwordToken } from './auth.js'
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
const JOURNEY_SLUG = `browser-journey-${RUN}`
const JOURNEY_TITLE = `Browser journey ${RUN}`
const ADMIN_EMAIL = `browser-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'browser-admin-password'
const OUTSIDER_PASSWORD = 'browser-outsider-password'

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

/** Sign in on the Keycloak page when the session is absent, then wait for the app. */
async function signIn(page: Page, publicUrl: string): Promise<void> {
  // A `signIn` on an already signed-in page must not wait for a login form
  // that never appears. The session endpoint shares the browser's cookies, so
  // it answers the question without a timeout.
  const session = await page.request.get(`${publicUrl}/api/v1/session`)
  await page.goto(publicUrl)
  if (session.status() === 401) {
    await page.locator('#username').waitFor({ timeout: 30_000 })
    await page.fill('#username', ADMIN_EMAIL)
    await page.fill('#password', ADMIN_PASSWORD)
    await page.click('#kc-login')
  }
  await page.locator('.app-header').waitFor({ timeout: 30_000 })
}

/** Click one step's grant control and wait for the operation it appends. */
async function grantOutcomes(page: Page, stepIndex: number): Promise<void> {
  const appended = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/operations') && response.request().method() === 'POST'
  )
  await page.click(`[data-grant="${stepIndex}"]`)
  expect((await appended).status(), 'the grant is appended').toBe(201)
}

/** The instance id in one task link. */
function instanceOfHref(href: string, publicUrl: string): string {
  const id = new URL(href, publicUrl).searchParams.get('instance')
  if (id === null || id === '') throw new Error(`the link ${href} names no instance`)
  return id
}

test('#224 a person signs in, builds a flow, publishes it and opens the form', async () => {
  const { page, publicUrl } = requireSetup()
  await signIn(page, publicUrl)
  await page.getByRole('heading', { name: 'Build your first flow' }).waitFor({ timeout: 30_000 })

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

test('#226 a person fills, claims, approves and reads the three inbox tabs', async () => {
  const { page, publicUrl, config } = requireSetup()
  await signIn(page, publicUrl)

  // A fresh two-step flow: `request` is filled by the starter, `approve` is
  // approved by the starter too, so one person can walk the whole journey.
  await page.goto(`${publicUrl}/?new=1`)
  await page.getByRole('heading', { name: 'Create a flow' }).waitFor({ timeout: 30_000 })
  await page.fill('#flow-slug', JOURNEY_SLUG)
  await page.fill('#flow-title', JOURNEY_TITLE)
  await page.getByRole('button', { name: 'Create flow' }).click()
  await page.locator('[data-add-step]').waitFor({ timeout: 30_000 })

  await page.fill('[data-step-index="0"] [data-step-key]', 'request')
  await page.click('[data-step-index="0"] [data-add-field="0"]')
  await page.fill('[data-step-index="0"] [data-field-index="0"] [data-field-key]', 'summary')
  await page.fill('[data-step-index="0"] [data-field-index="0"] [data-field-label]', 'Summary')

  await page.click('[data-add-step]')
  await page.locator('[data-step-index="1"]').waitFor()

  // The request submits; the approval approves. Blurring the input fires the
  // change event that re-renders the grant grid, so the checkboxes name the
  // outcomes the step now offers.
  await page.fill('[data-step-index="0"] [data-outcomes]', 'submit')
  await page.locator('[data-builder-title]').click()
  await page.locator('[data-step-index="0"] [data-grant-outcome="submit"]').waitFor()
  await page.fill('[data-step-index="1"] [data-step-key]', 'approve')
  await page.fill('[data-step-index="1"] [data-outcomes]', 'approve')
  await page.locator('[data-builder-title]').click()
  await page.locator('[data-step-index="1"] [data-grant-outcome="approve"]').waitFor()

  await page.click('[data-save]')
  await page.waitForFunction(() =>
    document.querySelector('[data-builder-status]')?.textContent?.startsWith('Saved')
  )
  await page.click('[data-publish]')
  await page.waitForFunction(() =>
    document.querySelector('[data-published]')?.textContent?.includes('Published version 1')
  )

  // Both steps grant their outcome to a `starter` target. The builder resolves
  // that target to the signed-in principal, so this person can complete both.
  await grantOutcomes(page, 0)
  await grantOutcomes(page, 1)

  await page.goto(`${publicUrl}/?flow=${JOURNEY_SLUG}`)
  const summary = page.locator('input[name="summary"]')
  await summary.waitFor({ timeout: 30_000 })
  await summary.fill('Please approve the first request')
  await page.click('[data-start]')
  const link = page.locator('.instance-link a')
  await link.waitFor({ timeout: 30_000 })
  const href = await link.getAttribute('href')
  if (href === null) throw new Error('the start page showed no instance link')
  const instanceId = instanceOfHref(href, publicUrl)
  const taskUrl = new URL(href, publicUrl).toString()

  // After the start, Started by me holds the instance and the request is
  // unopened (VT-1, VT-2).
  await page.goto(`${publicUrl}/?inbox=1&tab=started`)
  const startedItem = page.locator(`[data-inbox-instance="${instanceId}"]`)
  await startedItem.waitFor({ timeout: 30_000 })
  expect(await startedItem.getAttribute('data-inbox-state')).toBe('unopened')

  // Claim the request, then submit it. The page re-reads after each accepted
  // action, so it shows the approval step next (AS-2, I5).
  await page.goto(taskUrl)
  await page.locator('[data-claim]').waitFor({ timeout: 30_000 })
  expect(await page.textContent('.instance-status')).toContain('Step 1 of 2')
  await page.click('[data-claim]')
  await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'Claimed')
  await page.click('[data-outcome="submit"]')
  await page.waitForFunction(() =>
    document.querySelector('.instance-status')?.textContent?.includes('Step 2 of 2')
  )

  // The approval is available to its assignee and the completed request left
  // My tasks.
  await page.goto(`${publicUrl}/?inbox=1&tab=available`)
  const availableItem = page.locator(`[data-inbox-instance="${instanceId}"]`)
  await availableItem.waitFor({ timeout: 30_000 })
  expect(await availableItem.getAttribute('data-inbox-state')).toBe('unopened')
  await page.goto(`${publicUrl}/?inbox=1&tab=my`)
  await page.locator('[data-inbox-tab="my"]').waitFor({ timeout: 30_000 })
  expect(
    await page.locator(`[data-inbox-instance="${instanceId}"]`).count(),
    'the completed request left my tasks'
  ).toBe(0)

  // A stale completion reusing the version the request was completed at
  // answers 409 and appends nothing (I5).
  const token = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  const stale = await fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: randomUUID(),
      type: 'step.completed@1',
      at: Date.now(),
      actor: 'user:someone-else',
      payload: { instanceId, version: 1, outcome: 'submit', values: {} },
    }),
  })
  expect(stale.status, await stale.text()).toBe(409)

  // Claim the approval: it moves to My tasks with the holder (AS-2, VT-2).
  await page.goto(taskUrl)
  await page.locator('[data-claim]').waitFor({ timeout: 30_000 })
  expect(await page.textContent('.instance-status')).toContain('Step 2 of 2')
  await page.click('[data-claim]')
  await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'Claimed')
  await page.goto(`${publicUrl}/?inbox=1&tab=my`)
  const myItem = page.locator(`[data-inbox-instance="${instanceId}"]`)
  await myItem.waitFor({ timeout: 30_000 })
  expect(await myItem.getAttribute('data-inbox-state')).toBe('opened')

  // Approve it. Only the holder sees the outcome controls, and the done
  // instance shows Done with no form (VT-1, FM-3).
  await page.goto(taskUrl)
  await page.locator('[data-outcome="approve"]').waitFor({ timeout: 30_000 })
  expect(await page.locator('[data-claim]').count(), 'the holder needs no claim').toBe(0)
  await page.click('[data-outcome="approve"]')
  const done = page.locator('[data-done]')
  await done.waitFor({ timeout: 30_000 })
  expect(await done.textContent()).toBe('Done')

  // The done instance is gone from every open tab.
  for (const tab of ['my', 'available', 'started'] as const) {
    await page.goto(`${publicUrl}/?inbox=1&tab=${tab}`)
    await page.locator(`[data-inbox-tab="${tab}"]`).waitFor({ timeout: 30_000 })
    expect(
      await page.locator(`[data-inbox-instance="${instanceId}"]`).count(),
      `the done instance is absent from ${tab}`
    ).toBe(0)
  }

  // A second principal reads none of these items: the session filter is the
  // authorization, not a view of every task (I8, AS-2).
  const adminToken = await keycloakAdminToken(config)
  const username = `browser-outsider-${RUN}`
  await createUser(config, adminToken, {
    username,
    email: `${username}@test.local`,
    firstName: 'Out',
    lastName: 'Sider',
    password: OUTSIDER_PASSWORD,
  })
  const outsiderToken = await passwordToken(config, username, OUTSIDER_PASSWORD)
  for (const tab of ['my', 'available', 'started'] as const) {
    const response = await fetch(`${publicUrl}/api/v1/inbox?tab=${tab}`, {
      headers: { authorization: `Bearer ${outsiderToken}` },
    })
    expect(response.status, `GET /api/v1/inbox?tab=${tab}`).toBe(200)
    const items = (await response.json()) as readonly { instanceId: string }[]
    expect(
      items.some((item) => item.instanceId === instanceId),
      `the outsider reads no ${tab} item`
    ).toBe(false)
  }
}, 120_000)
