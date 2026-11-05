import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createUser, json, keycloakAdminToken, passwordToken, readSession } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #264, S02, S03, S04, AC-3, AC-4, DF-3, DF-6, RT-6, VT-6: the
// interface paths of sharing, concurrent editing and the version
// difference, against the real stack. Dana (the administrator) grants
// through the sharing panel's presets and the API lists scopes only (S02);
// Jordan, who holds send_back alone, is offered Send back alone and an
// approval through the API is refused. Priya's edit-class write and Dana's
// structural write land together through the three-way merge, and the diff
// view names each author (S03). Dana publishes a version with a new
// required field while Sam's draft is open, and Sam's form says so and
// highlights the field; the diff from version 1 to 2 shows it (S04).

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `sharing-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'sharing-admin-password'
const PASSWORD = 'sharing-person-password'
const SHARE_SLUG = `sharing-${RUN}`
const EDIT_SLUG = `edit-text-${RUN}`
const LIVE_SLUG = `add-field-${RUN}`

type Person = {
  readonly username: string
  readonly token: string
  /** The principal id the engine stores (ID-4). */
  readonly id: string
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly browser: Browser
  readonly page: Page
  readonly adminToken: string
  readonly adminId: string
  readonly priya: Person
  readonly sam: Person
  readonly jordan: Person
  readonly lee: Person
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-sharing-'))
    const databaseUrl = databaseUrlForRun(config.databaseUrl)
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const service = await startEnform(
      [
        'init',
        '--config',
        join(dir, 'enform.toml'),
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
    const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
    const adminId = (await readSession(publicUrl, adminToken)).principal.id
    const keycloak = await keycloakAdminToken(config)
    const person = async (name: string): Promise<Person> => {
      const username = `${name}-${RUN}`
      await createUser(config, keycloak, {
        username,
        email: `${username}@test.local`,
        firstName: name,
        lastName: RUN,
        password: PASSWORD,
      })
      const token = await passwordToken(config, username, PASSWORD)
      return { username, token, id: (await readSession(publicUrl, token)).principal.id }
    }
    const [priya, sam, jordan, lee] = await Promise.all([
      person('priya'),
      person('sam'),
      person('jordan'),
      person('lee'),
    ])
    const browser = await chromium.launch()
    const page = await browser.newPage()
    setup = {
      config,
      dir,
      publicUrl,
      service,
      browser,
      page,
      adminToken,
      adminId,
      priya,
      sam,
      jordan,
      lee,
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

function requireSetup(): Setup {
  if (setup === undefined) {
    throw setupError ?? new Error('integration: the sharing setup did not run')
  }
  return setup
}

/** Sign in on the Keycloak page when the session is absent, then wait for the app. */
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

/** Call one API path as a bearer principal. */
async function api(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {}
): Promise<Response> {
  const { publicUrl } = requireSetup()
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${publicUrl}${path}`, {
    ...(init.method === undefined ? {} : { method: init.method }),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

async function apiJson<T>(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {}
): Promise<T> {
  return json<T>(await api(token, path, init), `${init.method ?? 'GET'} ${path}`)
}

/** Post one operation as a bearer principal. */
async function post(
  person: { readonly token: string; readonly id: string },
  type: string,
  payload: Record<string, unknown>
): Promise<Response> {
  return api(person.token, '/api/v1/operations', {
    method: 'POST',
    body: { id: randomUUID(), type, at: Date.now(), actor: person.id, payload },
  })
}

/** Grant scopes as the administrator, through the same operation the panel posts (AC-2). */
async function grant(
  principal: string,
  scopes: readonly string[],
  resource: string
): Promise<void> {
  const { adminToken, adminId } = requireSetup()
  const response = await post({ token: adminToken, id: adminId }, 'config.grant.changed@1', {
    principal,
    scopes,
    resource,
  })
  expect(response.status, await response.text()).toBe(201)
}

type Definition = Record<string, unknown>

/** The two-step flow: the request form, then the registrar step with its three outcomes. */
function definition(
  registrars: readonly string[],
  options: { readonly label?: string; readonly reason?: boolean } = {}
): Definition {
  const fields = [
    { key: 'summary', control: 'text', label: options.label ?? 'Sumary', required: true },
    ...(options.reason === true
      ? [{ key: 'reason_category', control: 'text', label: 'Reason', required: true }]
      : []),
  ]
  const keys = fields.map((field) => field.key)
  return {
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields,
        visible: keys,
        editable: keys,
      },
      {
        key: 'registrar',
        targets: registrars.map((user) => ({ user })),
        outcomes: ['approve', 'reject', 'send_back'],
      },
    ],
  }
}

type Draft = { version: number; draftHash?: string; definition?: Definition; changes?: unknown[] }

/** Create a flow as the administrator, write its definition and publish version 1. */
async function publishedFlow(slug: string, body: Definition): Promise<void> {
  const { adminToken } = requireSetup()
  await apiJson<Draft>(adminToken, '/api/v1/flows', {
    method: 'POST',
    body: { slug, title: `Flow ${slug}` },
  })
  await apiJson<Draft>(adminToken, `/api/v1/flows/${slug}/draft`, {
    method: 'PUT',
    body: { version: 1, definition: body },
  })
  await apiJson<unknown>(adminToken, `/api/v1/flows/${slug}/publish`, {
    method: 'POST',
    body: { version: 1 },
  })
}

/** Wait for the next appended operation the page posts. */
function nextAppend(page: Page): Promise<number> {
  return page
    .waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/operations') && response.request().method() === 'POST'
    )
    .then((response) => response.status())
}

test('#264 S02 a preset grants scopes only, the panel answers who can approve, and Jordan is offered Send back alone', async () => {
  const { page, adminToken, adminId, publicUrl, browser, sam, jordan, lee } = requireSetup()
  await publishedFlow(SHARE_SLUG, definition([jordan.id, lee.id]))

  // Dana opens the builder: the sharing panel lists no grant of the flow yet
  // but the ones the creation made, and she grants through the presets.
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await page.goto(`${publicUrl}/?flow=${SHARE_SLUG}&builder=1`)
  await page.locator('[data-share-add]').waitFor({ timeout: 30_000 })
  const share = async (principal: string, step: string, preset: string): Promise<void> => {
    await page.fill('[data-share-principal]', principal)
    await page.selectOption('[data-share-resource]', step)
    await page.selectOption('[data-share-preset]', preset)
    const appended = nextAppend(page)
    await page.click('[data-share-add]')
    expect(await appended, `the ${preset} grant is appended`).toBe(201)
    await page
      .locator(`[data-grant][data-grant-principal="${principal}"]`)
      .first()
      .waitFor({ timeout: 30_000 })
  }
  await share(jordan.id, 'registrar', 'reviewer')
  await share(lee.id, 'registrar', 'approver')
  await share(sam.id, '', 'starter')

  // The API lists scopes only: a preset has no meaning in the engine (AC-3).
  const grants = await apiJson<{ principal: string; scopes: string[]; resource: string }[]>(
    adminToken,
    `/api/v1/flows/${SHARE_SLUG}/grants`
  )
  expect(grants).toContainEqual({
    principal: jordan.id,
    scopes: ['step.outcome:send_back'],
    resource: `flow:${SHARE_SLUG}/step:registrar`,
  })
  expect(grants).toContainEqual({
    principal: lee.id,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: `flow:${SHARE_SLUG}/step:registrar`,
  })
  expect(grants).toContainEqual({
    principal: sam.id,
    scopes: ['instance.start'],
    resource: `flow:${SHARE_SLUG}`,
  })
  for (const entry of grants)
    expect(Object.keys(entry).sort()).toEqual(['principal', 'resource', 'scopes'])

  // Each grant change is in the change feed with its author (VT-6, AC-2).
  const feed = await apiJson<{ type: string; actor?: string; at: number }[]>(
    adminToken,
    `/api/v1/timeline?flow=${SHARE_SLUG}&type=config.grant.changed@1`
  )
  expect(feed.length).toBeGreaterThanOrEqual(3)
  expect(feed.every((entry) => entry.actor === adminId && entry.at > 0)).toBe(true)

  // One panel answers "Who can approve at the registrar step?" (S02).
  await page.fill('[data-who-outcome]', 'approve')
  await page.selectOption('[data-who-step]', 'registrar')
  await page.click('[data-who-ask]')
  const answer = await page.textContent('[data-who-answer]')
  expect(answer).toContain(lee.id)
  expect(answer).not.toContain(jordan.id)

  // Sam starts and submits a request, so the registrar task is open.
  const instanceId = randomUUID()
  const started = await post(sam, 'instance.started@1', {
    flow: SHARE_SLUG,
    instanceId,
    values: { summary: 'Three extra credits' },
  })
  expect(started.status, await started.text()).toBe(201)
  const draft = await apiJson<{ version: number }>(sam.token, `/api/v1/instances/${instanceId}`)
  const submitted = await post(sam, 'instance.submitted@1', {
    instanceId,
    version: draft.version,
    values: { summary: 'Three extra credits' },
  })
  expect(submitted.status, await submitted.text()).toBe(201)

  // Jordan claims the task in a browser of his own: the only outcome offered
  // is Send back (AC-4), and an approval through the API is refused.
  const context = await browser.newContext()
  const jordanPage = await context.newPage()
  try {
    await signIn(jordanPage, jordan.username, PASSWORD)
    await jordanPage.goto(`${publicUrl}/?flow=${SHARE_SLUG}&instance=${instanceId}`)
    await jordanPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
    await jordanPage.click('[data-claim]')
    await jordanPage.locator('[data-outcome="send_back"]').waitFor({ timeout: 30_000 })
    expect(await jordanPage.locator('[data-outcome]').count(), 'Send back alone').toBe(1)
    expect(await jordanPage.locator('[data-outcome="approve"]').count()).toBe(0)
    const held = await apiJson<{ version: number; allowedOutcomes: string[] }>(
      jordan.token,
      `/api/v1/instances/${instanceId}`
    )
    expect(held.allowedOutcomes).toEqual(['send_back'])
    const approve = await post(jordan, 'step.completed@1', {
      instanceId,
      version: held.version,
      outcome: 'approve',
      values: {},
    })
    expect(approve.status, await approve.text()).toBe(403)
  } finally {
    await context.close()
  }
}, 180_000)

test('#264 S03 Priya and Dana edit the same draft at the same time, nobody is blocked, and the diff names each author', async () => {
  const { page, adminToken, adminId, publicUrl, priya, jordan, lee } = requireSetup()
  await publishedFlow(EDIT_SLUG, definition([jordan.id, lee.id]))
  await grant(
    priya.id,
    ['flow.edit', 'flow.dryrun', 'instance.read', 'instance.timeline', 'task.reassign'],
    `flow:${EDIT_SLUG}`
  )

  // Both read the same draft, so both writes name the same base.
  const base = await apiJson<Draft>(priya.token, `/api/v1/flows/${EDIT_SLUG}/draft`)
  expect(base.draftHash).toBeDefined()
  // Dana adds a field first.
  const dana = await apiJson<Draft>(adminToken, `/api/v1/flows/${EDIT_SLUG}/draft`, {
    method: 'PUT',
    body: {
      version: base.version,
      baseHash: base.draftHash,
      definition: definition([jordan.id, lee.id], { reason: true }),
    },
  })
  expect(dana.draftHash).not.toBe(base.draftHash)
  // Priya fixes the label on the draft she read: the write merges, nobody is
  // blocked (DF-3), and her write records only her edit-class change (DF-5).
  const priyaWrite = await api(priya.token, `/api/v1/flows/${EDIT_SLUG}/draft`, {
    method: 'PUT',
    body: {
      version: base.version,
      baseHash: base.draftHash,
      definition: definition([jordan.id, lee.id], { label: 'Summary' }),
    },
  })
  const merged = (await priyaWrite.json()) as Draft
  expect(priyaWrite.status, JSON.stringify(merged)).toBe(200)
  const steps = merged.definition?.steps as
    | { fields: { key: string; label: string }[] }[]
    | undefined
  const fields = steps?.[0]?.fields ?? []
  expect(fields.map((field) => [field.key, field.label])).toEqual([
    ['summary', 'Summary'],
    ['reason_category', 'Reason'],
  ])
  expect(
    (merged.changes as { path: string; class: string }[]).map((change) => change.path)
  ).toEqual(['/steps/request/fields/summary/label'])
  // A structural change by Priya is refused and names the scope (S03, DF-5).
  const structural = await api(priya.token, `/api/v1/flows/${EDIT_SLUG}/draft`, {
    method: 'PUT',
    body: {
      version: base.version,
      baseHash: merged.draftHash,
      definition: {
        ...definition([jordan.id, lee.id], { label: 'Summary', reason: true }),
        steps: [
          ...(definition([jordan.id, lee.id], { label: 'Summary', reason: true })
            .steps as unknown[]),
          { key: 'chair', targets: [{ user: lee.id }], outcomes: ['approve'] },
        ],
      },
    },
  })
  expect(structural.status).toBe(403)
  expect(await structural.text()).toContain('flow.build')

  // The diff view on Dana's builder page shows the draft against version 1
  // with the author of each change (DF-6, S03).
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await page.goto(`${publicUrl}/?flow=${EDIT_SLUG}&builder=1`)
  await page.locator('[data-diff-change]').first().waitFor({ timeout: 30_000 })
  const changes = page.locator('[data-diff-change]')
  const byPath = new Map<string, string | null>()
  for (const item of await changes.all()) {
    byPath.set(
      (await item.getAttribute('data-diff-path')) ?? '',
      await item.getAttribute('data-diff-actor')
    )
  }
  // Priya's label beside Dana's field and the visible and editable lists the
  // field joined.
  expect([...byPath.keys()].sort()).toEqual([
    '/steps/request/editable',
    '/steps/request/fields/reason_category',
    '/steps/request/fields/summary/label',
    '/steps/request/visible',
  ])
  expect(byPath.get('/steps/request/fields/summary/label')).toBe(priya.id)
  expect(byPath.get('/steps/request/fields/reason_category')).toBe(adminId)
  expect(byPath.get('/steps/request/visible')).toBe(adminId)
}, 180_000)

test('#264 S04 Dana publishes a new required field while Sam has a draft open: his form says so, and the diff shows the field', async () => {
  const { page, adminToken, publicUrl, browser, sam, jordan, lee } = requireSetup()
  await publishedFlow(LIVE_SLUG, definition([jordan.id, lee.id], { label: 'Summary' }))
  await grant(sam.id, ['instance.start'], `flow:${LIVE_SLUG}`)
  const instanceId = randomUUID()
  const started = await post(sam, 'instance.started@1', {
    flow: LIVE_SLUG,
    instanceId,
    values: { summary: 'Three extra credits' },
  })
  expect(started.status, await started.text()).toBe(201)

  // Dana adds the required field and publishes version 2.
  const draft = await apiJson<Draft>(adminToken, `/api/v1/flows/${LIVE_SLUG}/draft`)
  await apiJson<Draft>(adminToken, `/api/v1/flows/${LIVE_SLUG}/draft`, {
    method: 'PUT',
    body: {
      version: draft.version,
      definition: definition([jordan.id, lee.id], { label: 'Summary', reason: true }),
    },
  })
  await apiJson<unknown>(adminToken, `/api/v1/flows/${LIVE_SLUG}/publish`, {
    method: 'POST',
    body: { version: draft.version },
  })

  // Sam opens his draft again: it moved to version 2, keeps his value, and
  // the page says one new field needs his answer (RT-6, S04).
  const context = await browser.newContext()
  const samPage = await context.newPage()
  try {
    await signIn(samPage, sam.username, PASSWORD)
    await samPage.goto(`${publicUrl}/?flow=${LIVE_SLUG}&instance=${instanceId}`)
    const notice = samPage.locator('[data-form-changed]')
    await notice.waitFor({ timeout: 30_000 })
    expect(await notice.textContent()).toBe('This form changed. One new field needs your answer.')
    const reason = samPage.locator('[data-field-row="reason_category"]')
    expect(await reason.getAttribute('data-new-required')).toBe('true')
    expect(await samPage.inputValue('input[name="summary"]')).toBe('Three extra credits')
  } finally {
    await context.close()
  }

  // The difference from version 1 to version 2 shows the new field (DF-6).
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await page.goto(`${publicUrl}/?flow=${LIVE_SLUG}&builder=1`)
  await page.locator('[data-diff-show]').waitFor({ timeout: 30_000 })
  await page.selectOption('[data-diff-from]', '1')
  await page.selectOption('[data-diff-to]', '2')
  await page.click('[data-diff-show]')
  const added = page.locator(
    '[data-diff-change][data-diff-path="/steps/request/fields/reason_category"]'
  )
  await added.waitFor({ timeout: 30_000 })
  expect(await added.getAttribute('data-diff-class')).toBe('structural')
}, 180_000)
