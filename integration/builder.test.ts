import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createUser, json, keycloakAdminToken, passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #264, S01, S03, S05, S08, S12, DF-3, DF-5, FM-1, FM-2, FM-3, FM-5,
// ID-3, WF-5, SE-3, SE-4, DR-1, DR-3, DR-4, DR-5, DR-6, RT-2, A4: the
// builder's interface paths in Chromium against the real stack. Dana creates
// the flow in the builder, sets the flow and step settings, adds a section,
// fields and steps, draws the skip condition "Skip this step when Overload
// credits ≤ 2" and a rule, saves, runs a dry run from the toolbar that
// explains the route, the assignees, the preview inbox and the fired timers,
// runs as another person, and publishes. Priya, who holds flow.edit and not
// flow.build, opens the builder with the structural controls disabled, edits
// a label, is refused a run as another person, and Dana's open builder
// refreshes with Priya's change when it holds no edit and keeps Dana's edit
// when it does. The server stays the authority: the saved definition is read
// back through the API and holds the exact JSON Logic tree.

const RUN = randomUUID().slice(0, 8)
const SLUG = `builder-${RUN}`
const TITLE = `Builder flow ${RUN}`
const TEAM = `registrar-${RUN}`
const ADMIN_EMAIL = `builder-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'builder-admin-password'
const PRIYA_PASSWORD = 'builder-priya-password'
const PEOPLE_PASSWORD = 'builder-people-password'

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly browser: Browser
  readonly page: Page
  readonly priya: { readonly id: string; readonly email: string }
  readonly okafor: { readonly id: string; readonly email: string }
  readonly lee: { readonly id: string; readonly email: string }
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-builder-'))
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
    const adminToken = await keycloakAdminToken(config)
    const person = async (
      name: string,
      first: string,
      last: string,
      password: string
    ): Promise<{ id: string; email: string }> => {
      const username = `builder-${name}-${RUN}`
      const email = `${username}@test.local`
      const id = await createUser(config, adminToken, {
        username,
        email,
        firstName: first,
        lastName: last,
        password,
      })
      return { id, email }
    }
    const priya = await person('priya', 'Priya', 'Editor', PRIYA_PASSWORD)
    const okafor = await person('okafor', 'Dr', 'Okafor', PEOPLE_PASSWORD)
    const lee = await person('lee', 'Lee', 'Registrar', PEOPLE_PASSWORD)
    const browser = await chromium.launch()
    const page = await browser.newPage()
    setup = { config, dir, publicUrl, service, browser, page, priya, okafor, lee }
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
    throw setupError ?? new Error('integration: the builder setup did not run')
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

async function api(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${requireSetup().publicUrl}${path}`, { ...init, headers })
}

async function apiJson<T>(token: string, path: string): Promise<T> {
  return json<T>(await api(token, path), `GET ${path}`)
}

async function postIntent(token: string, body: Record<string, unknown>): Promise<Response> {
  return api(token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), at: Date.now(), actor: 'ignored', ...body }),
  })
}

/** Blur the focused input so its change event re-renders the builder. */
async function blur(page: Page): Promise<void> {
  await page.locator('[data-builder-title]').click()
}

/** Wait until the builder status starts with a text. */
async function waitForStatus(page: Page, prefix: string): Promise<void> {
  await page.waitForFunction(
    (text) => document.querySelector('[data-builder-status]')?.textContent?.startsWith(text),
    prefix,
    { timeout: 30_000 }
  )
}

/** Run the dry-run panel with its current inputs and wait for a fresh answer. */
async function runDryRun(page: Page): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/v1/flows/${SLUG}/dry-run`) &&
      response.request().method() === 'POST'
  )
  await page.click('[data-dry-go]')
  await answered
  await page.waitForFunction(
    () =>
      document.querySelector('[data-dry-result]') !== null ||
      (document.querySelector('[data-dry-status]')?.textContent ?? '') !== ''
  )
}

type DraftView = {
  readonly version: number
  readonly definition: Record<string, unknown> & { readonly steps: Record<string, unknown>[] }
}

test('#264 S01 S05 S08 S12 Dana builds the flow with its settings, sections, conditions and timers, dry-runs it and publishes', async () => {
  const { page, publicUrl, config, okafor, lee } = requireSetup()
  const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  // The registrar team that the escalation names (SE-4, AS-6).
  for (const payload of [
    { team: TEAM, change: 'created' },
    { team: TEAM, change: 'member-added', member: lee.id },
  ]) {
    const response = await postIntent(adminToken, { type: 'config.team.changed@1', payload })
    expect(response.status, await response.text()).toBe(201)
  }

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await page.goto(`${publicUrl}/?new=1`)
  await page.getByRole('heading', { name: 'Create a flow' }).waitFor({ timeout: 30_000 })
  await page.fill('#flow-slug', SLUG)
  await page.fill('#flow-title', TITLE)
  await page.getByRole('button', { name: 'Create flow' }).click()
  await page.locator('[data-add-step]').waitFor({ timeout: 30_000 })

  // The flow settings (ID-3, WF-5): anonymous access shows its label at once.
  expect(await page.textContent('[data-anonymous-label]')).toContain('Anonymous access: off')
  await page.check('[data-anonymous]')
  expect(await page.textContent('[data-anonymous-label]')).toContain('Anonymous access: on')
  await page.fill('[data-undo-hours]', '48')

  // The request step: one section with three fields (FM-1).
  const request = '[data-step-index="0"]'
  await page.fill(`${request} [data-step-key]`, 'request')
  await page.click(`${request} [data-add-section]`)
  await page.locator(`${request} [data-section-index="0"]`).waitFor()
  await page.fill(`${request} [data-section-index="0"] [data-section-key]`, 'course')
  await blur(page)
  const fields: readonly [string, string, string][] = [
    ['summary', 'Summary', 'text'],
    ['overload_credits', 'Overload credits', 'number'],
    ['advisor', 'Advisor', 'user'],
  ]
  for (const [index, [key, label, control]] of fields.entries()) {
    await page.click(`${request} [data-add-field="0"]`)
    const field = `${request} [data-field-index="${index}"]`
    await page.locator(field).waitFor()
    await page.fill(`${field} [data-field-key]`, key)
    await page.fill(`${field} [data-field-label]`, label)
    await page.selectOption(`${field} [data-field-control]`, control)
    expect(
      await page.locator(`${field} [data-field-section]`).inputValue(),
      'the field belongs to the section'
    ).toBe('course')
  }
  await page.fill(`${request} [data-outcomes]`, 'submit')
  await blur(page)

  // The advisor step: a field target, timers and an escalation (AS-1, SE-3, SE-4).
  await page.click('[data-add-step]')
  const advisor = '[data-step-index="1"]'
  await page.locator(advisor).waitFor()
  await page.fill(`${advisor} [data-step-key]`, 'advisor')
  await page.fill(`${advisor} [data-target="0"]`, 'field:advisor')
  await blur(page)
  await page.fill(`${advisor} [data-outcomes]`, 'approve')
  await blur(page)
  await page.fill(`${advisor} [data-reminder-minutes]`, '1440')
  await page.fill(`${advisor} [data-deadline-minutes]`, '4320')
  await page.fill(`${advisor} [data-escalation-targets]`, `team:${TEAM}`)
  await page.selectOption(`${advisor} [data-takeover]`, 'after-idle')
  await page.fill(`${advisor} [data-idle-minutes]`, '240')

  // The chair step with the skip condition drawn in the builder (FM-2, FM-5, S05).
  await page.click('[data-add-step]')
  const chair = '[data-step-index="2"]'
  await page.locator(chair).waitFor()
  await page.fill(`${chair} [data-step-key]`, 'chair')
  await page.fill(`${chair} [data-target="0"]`, `user:${lee.id}`)
  await blur(page)
  await page.fill(`${chair} [data-outcomes]`, 'approve')
  await blur(page)
  expect(await page.textContent(`${chair} [data-skip-text]`)).toBe('This step is never skipped.')
  await page.click(`${chair} [data-add-skip]`)
  await page.locator(`${chair} [data-skip-when] [data-condition-left]`).waitFor()
  await page.selectOption(`${chair} [data-skip-when] [data-condition-left]`, 'overload_credits')
  await page.selectOption(`${chair} [data-skip-when] [data-condition-op]`, '<=')
  await page.fill(`${chair} [data-skip-when] [data-condition-right]`, '2')
  expect(await page.textContent(`${chair} [data-skip-text]`)).toBe(
    'Skip this step when Overload credits ≤ 2'
  )

  // A rule on the request form: the advisor is required for a large overload (FM-2).
  await page.click(`${request} [data-add-rule]`)
  const rule = `${request} [data-rule-index="0"]`
  await page.locator(rule).waitFor()
  await page.selectOption(`${rule} [data-rule-effect]`, 'require')
  await page.fill(`${rule} [data-rule-targets]`, 'advisor')
  await page.selectOption(`${rule} [data-condition-left]`, 'overload_credits')
  await page.selectOption(`${rule} [data-condition-op]`, '>')
  await page.fill(`${rule} [data-condition-right]`, '6')
  expect(await page.textContent(`${rule} [data-rule-text]`)).toBe(
    'Require advisor when Overload credits > 6'
  )

  // The final step is chosen once the steps exist (WF-5).
  await page.selectOption('[data-final-step]', 'chair')

  await page.click('[data-save]')
  await waitForStatus(page, 'Saved')

  // The server holds the exact tree the builder drew, and every setting (DF-4, FM-5).
  const draft = await apiJson<DraftView>(adminToken, `/api/v1/flows/${SLUG}/draft`)
  expect(draft.definition.anonymous).toBe(true)
  expect(draft.definition.undoHours).toBe(48)
  expect(draft.definition.finalStep).toBe('chair')
  const [requestStep, advisorStep, chairStep] = draft.definition.steps
  expect(requestStep?.fields, 'a step with sections has no flat fields').toBeUndefined()
  expect(requestStep?.sections).toEqual([
    {
      key: 'course',
      fields: [
        { key: 'summary', control: 'text', label: 'Summary' },
        { key: 'overload_credits', control: 'number', label: 'Overload credits' },
        { key: 'advisor', control: 'user', label: 'Advisor' },
      ],
    },
  ])
  expect(requestStep?.rules).toEqual([
    { when: { '>': [{ var: 'overload_credits' }, 6] }, effect: 'require', targets: ['advisor'] },
  ])
  expect(advisorStep).toMatchObject({
    key: 'advisor',
    targets: [{ field: 'advisor' }],
    reminderMinutes: 1440,
    deadlineMinutes: 4320,
    escalationTargets: [{ team: TEAM }],
    takeover: 'after-idle',
    idleMinutes: 240,
  })
  expect(chairStep?.skipWhen).toEqual({ '<=': [{ var: 'overload_credits' }, 2] })
  expect(chairStep?.targets).toEqual([{ user: lee.id }])

  // The dry run from the toolbar (DR-1, S05, S08): two credits skip the chair
  // in grey with the condition in words, the advisor resolves through the
  // field target, and the preview inbox holds the assignment (DR-3).
  await page.click('[data-dry-run]')
  await page.locator('[data-dry-panel]').waitFor()
  await page.fill('[data-dry-field="summary"]', 'Overload request')
  await page.fill('[data-dry-field="overload_credits"]', '2')
  await page.fill('[data-dry-field="advisor"]', okafor.id)
  await runDryRun(page)
  const skipped = page.locator('[data-dry-step="chair"]')
  expect(await skipped.getAttribute('data-dry-state')).toBe('skipped')
  expect(await skipped.textContent()).toContain('Overload credits ≤ 2')
  expect(await page.textContent('[data-dry-step="advisor"]')).toContain(
    `field:advisor → ${okafor.id}`
  )
  expect(await page.textContent('[data-dry-next]')).toBe('A submit routes to advisor.')
  expect(await page.textContent('[data-dry-inbox]')).toContain(
    `Assignment to ${okafor.id} for advisor`
  )
  // One reminder per elapsed day up to the three-day deadline, all pending.
  expect(await page.locator('[data-dry-timer="reminder"][data-dry-fired="false"]').count()).toBe(3)
  expect(await page.locator('[data-dry-timer="escalation"][data-dry-fired="false"]').count()).toBe(
    1
  )

  // The simulated clock moved three days forward fires the reminders and the
  // escalation into the preview inbox (DR-4, S12).
  await page.fill('[data-dry-advance]', '4320')
  await runDryRun(page)
  expect(await page.textContent('[data-dry-clock]')).toContain('moved forward 4320 minutes')
  expect(
    await page.locator('[data-dry-timer="reminder"][data-dry-fired="true"]').count()
  ).toBeGreaterThan(0)
  expect(await page.locator('[data-dry-timer="escalation"][data-dry-fired="true"]').count()).toBe(1)
  const inbox = await page.textContent('[data-dry-inbox]')
  expect(inbox).toContain(`Reminder to ${okafor.id} for advisor`)
  expect(inbox).toContain(`Escalation to ${okafor.id} for advisor, adds team:${TEAM}`)

  // Four credits make the chair active, resolved through the user target (S05, S08).
  await page.fill('[data-dry-field="overload_credits"]', '4')
  await page.fill('[data-dry-advance]', '')
  await runDryRun(page)
  const active = page.locator('[data-dry-step="chair"]')
  expect(await active.getAttribute('data-dry-state')).toBe('active')
  expect(await active.textContent()).toContain(`user:${lee.id} → ${lee.id}`)

  // A run as another person needs org.impersonate, which the first
  // administrator holds; the log records the use and nothing else of any run
  // (DR-5, DR-6, I14).
  await page.fill('[data-dry-as]', okafor.id)
  await runDryRun(page)
  expect(await page.textContent('[data-dry-clock]')).toContain(`as ${okafor.id}`)
  const log = await apiJson<readonly { type: string; payload: Record<string, unknown> }[]>(
    adminToken,
    '/api/v1/log'
  )
  const recorded = log.filter((event) => event.type === 'dryrun.ran@1')
  expect(recorded).toHaveLength(1)
  expect(recorded[0]?.payload).toMatchObject({ flow: SLUG, version: 'draft', as: okafor.id })
  expect(
    log.some((event) => event.type.startsWith('instance.') || event.type.startsWith('step.')),
    'a dry run writes no instance event'
  ).toBe(false)

  // Dana publishes; the dry run then offers version 1 (DF-2, DR-1).
  await page.click('[data-publish]')
  await page.waitForFunction(() =>
    document.querySelector('[data-published]')?.textContent?.includes('Published version 1')
  )
  await page.click('[data-dry-run]')
  await page.click('[data-dry-run]')
  await page.locator('[data-dry-panel]').waitFor()
  expect(await page.locator('[data-dry-version] option[value="1"]').count()).toBe(1)
  await page.selectOption('[data-dry-version]', '1')
  await page.fill('[data-dry-as]', '')
  await runDryRun(page)
  expect(await page.textContent('[data-dry-clock]')).toContain('Ran version 1')
}, 180_000)

test('#264 S03 DF-5 Priya edits a label with the structural controls disabled, and Dana sees her change and her cursor', async () => {
  const { browser, page, publicUrl, config, priya, okafor } = requireSetup()
  const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  const granted = await postIntent(adminToken, {
    type: 'config.grant.changed@1',
    payload: {
      principal: priya.id,
      scopes: ['flow.edit', 'flow.dryrun'],
      resource: `flow:${SLUG}`,
    },
  })
  expect(granted.status, await granted.text()).toBe(201)

  // Dana's builder is open and live, with no unsaved edit (RT-1, RT-2).
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await page.goto(`${publicUrl}/?flow=${SLUG}&builder=1`)
  await page.locator('[data-add-step]').waitFor({ timeout: 30_000 })
  await page.waitForFunction(
    () => document.querySelector('[data-connection]')?.getAttribute('data-mode') === 'live',
    undefined,
    { timeout: 30_000 }
  )

  const context = await browser.newContext()
  try {
    const editor = await context.newPage()
    await signIn(editor, priya.email, PRIYA_PASSWORD)
    await editor.goto(`${publicUrl}/?flow=${SLUG}&builder=1`)
    await editor.locator('[data-edit-only]').waitFor({ timeout: 30_000 })
    const label = '[data-step-index="0"] [data-field-index="0"] [data-field-label]'
    expect(await editor.locator('[data-add-step]').isDisabled(), 'adding a step is off').toBe(true)
    expect(
      await editor.locator('[data-step-index="0"] [data-step-key]').isDisabled(),
      'a step key is structural'
    ).toBe(true)
    expect(
      await editor.locator('[data-step-index="0"] [data-add-field="0"]').isDisabled(),
      'adding a field is off'
    ).toBe(true)
    expect(await editor.locator(label).isDisabled(), 'a label is edit-class').toBe(false)

    // Priya's cursor shows on Dana's page with the field it is at (RT-2, S03).
    await editor.focus(label)
    await page.waitForFunction(
      () => (document.querySelector('[data-presence]')?.textContent ?? '').includes('Priya'),
      undefined,
      { timeout: 30_000 }
    )
    expect(await page.textContent('[data-presence]')).toContain('step:request/field:summary/label')

    // Priya's save is an edit-class change, so flow.edit allows it (DF-5).
    await editor.fill(label, 'Course summary')
    await editor.click('[data-save]')
    await waitForStatus(editor, 'Saved')

    // Dana's builder holds no edit, so it refreshes with Priya's label (DF-3, A4).
    await page.locator('[data-flow-changed="refreshed"]').waitFor({ timeout: 30_000 })
    expect(await page.locator(label).inputValue()).toBe('Course summary')

    // Dana types; Priya's next save is announced and Dana's edit stays (A4).
    await page.fill('[data-undo-hours]', '72')
    await editor.fill(label, 'Course summary, one line')
    await editor.click('[data-save]')
    await waitForStatus(editor, 'Saved')
    await page.locator('[data-flow-changed="unsaved"]').waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-undo-hours]').inputValue()).toBe('72')
    expect(await page.locator(label).inputValue()).toBe('Course summary')

    // Priya may dry-run, and a run as another person is refused without
    // org.impersonate, in the server's words (DR-5, I8).
    await editor.click('[data-dry-run]')
    await editor.locator('[data-dry-panel]').waitFor()
    await editor.fill('[data-dry-field="overload_credits"]', '4')
    await editor.fill('[data-dry-as]', okafor.id)
    await runDryRun(editor)
    expect(await editor.textContent('[data-dry-status]')).toContain('org.impersonate')
    expect(await editor.locator('[data-dry-result]').count()).toBe(0)
  } finally {
    await context.close()
  }
}, 180_000)
