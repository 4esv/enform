import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { FlowDefinition } from '../engine/definition.js'
import { json, passwordToken, readSession } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue OU-1, FM-3, VT-2, VT-5, I4, I8, I12, I13, ADR 0009: the instance PDF
// against the real Compose stack and the demo seed. The PDF is another read of
// the instance: the current step or a named one, the fields that step makes
// visible and the values the actor may read, then the tracker and the
// instance's own timeline. A hidden field and a hidden value never reach the
// page, a principal without the read scope gets 403, and a cleared, missing or
// unknown target gets 404. `enform admin rebuild` reproduces the same text
// from the log (I4).

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `pdf-admin-${RUN}@test.local`
const ADMIN_PASSWORD = `pdf-admin-${RUN}`
const HIDDEN_SLUG = `pdf-hidden-${RUN}`
const HIDDEN_TITLE = `Hidden fields ${RUN}`
const REPO = join(import.meta.dirname, '..')
const STANDARD_FONTS = join(REPO, 'node_modules', 'pdfjs-dist', 'standard_fonts')

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

/** The response of one flow write (api/openapi.yaml). */
type DraftFlow = {
  readonly slug: string
  readonly version: number
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly browser: Browser
  readonly seed: SeedOutput
  readonly readerToken: string
  readonly adminToken: string
  /** The instance of the custom flow whose first step hides one field. */
  readonly hiddenInstance: string
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-pdf-'))
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
    const seed = JSON.parse(seeded.stdout) as SeedOutput
    const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
    const admin = await readSession(publicUrl, adminToken)
    const reader = seedUser(seed, 'reader')
    const readerToken = await passwordToken(config, reader.email, reader.password)
    const hiddenInstance = await createHiddenFieldFlow(publicUrl, adminToken, admin.principal.id)
    const browser = await chromium.launch()
    setup = {
      config,
      dir,
      configPath,
      publicUrl,
      service,
      browser,
      seed,
      readerToken,
      adminToken,
      hiddenInstance,
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

/** The shared setup, or the reason that `enform init` and the seed did not produce it. */
function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the PDF setup did not run')
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

/** A demo user by role, from the seed output. */
function seedUser(seed: SeedOutput, role: string): DemoUser {
  const user = seed.users?.find((entry) => entry.role === role)
  if (user === undefined) throw new Error(`the demo seed has no ${role}`)
  return user
}

/** A demo user by role, from the shared setup. */
function castMember(role: string): DemoUser {
  return seedUser(requireSetup().seed, role)
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

/** Request one instance PDF as a bearer principal. */
async function getPdf(token: string, instanceId: string, step?: string): Promise<Response> {
  const { publicUrl } = requireSetup()
  const query = step === undefined ? '' : `?step=${encodeURIComponent(step)}`
  return fetch(`${publicUrl}/api/v1/instances/${instanceId}/pdf${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

/** Read the text of one PDF with the pdfjs-dist extractor. */
async function pdfText(pdf: Buffer): Promise<string> {
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: `${STANDARD_FONTS}/`,
  }).promise
  const pages: string[] = []
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  return pages.join('\n')
}

/** The body of one PDF response as bytes. */
async function pdfBody(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer())
}

/** One flow API call with the administrator's bearer token. */
async function adminJson<T>(
  publicUrl: string,
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return json<T>(await fetch(`${publicUrl}${path}`, { ...init, headers }), `${path}`)
}

/**
 * Create a flow whose first step shows one of its two fields (FM-3). The start
 * records a value for the hidden field too, so the PDF proves that the hidden
 * key and its value are absent, not that the value was never captured.
 */
async function createHiddenFieldFlow(
  publicUrl: string,
  token: string,
  adminId: string
): Promise<string> {
  const created = await adminJson<DraftFlow>(publicUrl, token, '/api/v1/flows', {
    method: 'POST',
    body: JSON.stringify({ slug: HIDDEN_SLUG, title: HIDDEN_TITLE }),
  })
  const definition: FlowDefinition = {
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [
          { key: 'shown', control: 'text', label: 'Shown field', required: true },
          { key: 'secret', control: 'text', label: 'Secret field' },
        ],
        visible: ['shown'],
        editable: ['shown'],
        outcomes: ['submit'],
      },
    ],
  }
  const written = await adminJson<DraftFlow>(
    publicUrl,
    token,
    `/api/v1/flows/${HIDDEN_SLUG}/draft`,
    {
      method: 'PUT',
      body: JSON.stringify({ version: created.version, definition }),
    }
  )
  await adminJson<unknown>(publicUrl, token, `/api/v1/flows/${HIDDEN_SLUG}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version: written.version }),
  })
  const instanceId = randomUUID()
  const response = await fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: randomUUID(),
      type: 'instance.started@1',
      at: Date.now(),
      actor: adminId,
      payload: {
        flow: HIDDEN_SLUG,
        instanceId,
        values: { shown: 'Visible value', secret: 'Hidden value' },
      },
    }),
  })
  if (response.status !== 201) {
    throw new Error(`starting the hidden-field instance failed: ${response.status}`)
  }
  return instanceId
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

test('#OU-1 a reader gets the form of the current step and the step history as a PDF', async () => {
  const { publicUrl, readerToken } = requireSetup()
  const reader = castMember('reader')
  const starter = castMember('starter')
  const instance = demoInstance((entry) => entry.step === 'registrar')
  const response = await getPdf(readerToken, instance.id, 'request')
  expect(response.status, 'the reader may read the instance').toBe(200)
  expect(response.headers.get('content-type'), 'the response is a PDF').toContain('application/pdf')
  expect(response.headers.get('content-disposition'), 'the filename names the instance').toContain(
    instance.id
  )
  expect(response.headers.get('content-disposition'), 'the filename names the step').toContain(
    'request.pdf'
  )

  const body = await pdfBody(response)
  expect(body.subarray(0, 5).toString(), 'the body starts with the PDF header').toBe('%PDF-')
  const text = await pdfText(body)

  expect(text, 'the flow title is in the header').toContain(requireSetup().seed.flow?.title ?? '')
  expect(text, 'the flow slug is in the header').toContain(flowSlug())
  expect(text, 'the instance id is in the header').toContain(instance.id)
  expect(text, 'the named step is in the header').toContain('Step: request')
  expect(text, 'the header names the requesting actor').toContain(`Actor: ${reader.id}`)
  expect(text, 'the visible label is rendered').toContain('Field: Summary (summary)')
  expect(text, 'the second visible label is rendered').toContain(
    'Field: Overload credits (credits)'
  )
  expect(text, 'the visible value is rendered').toContain(
    'Three extra credits for a graduating student'
  )
  expect(text, 'the numeric visible value is rendered').toContain('Value: 2')
  expect(text, 'the start is history').toContain('instance.started@1')
  expect(text, 'the claim is history').toContain('step.claimed@1')
  expect(text, 'the completion is history').toContain('step.completed@1')
  expect(text, 'the history names the actor').toContain(starter.id)
  expect(text, 'the footer is on the page').toContain('enform - page 1 of 1')
  expect(publicUrl, 'the test reads the served URL').toContain('http')
})

test('#OU-1 a hidden field, a hidden value and a hidden step form are absent', async () => {
  const { readerToken } = requireSetup()
  const hidden = await getPdf(requireSetup().adminToken, requireSetup().hiddenInstance)
  expect(hidden.status, 'the administrator may read the custom instance').toBe(200)
  const hiddenText = await pdfText(await pdfBody(hidden))
  expect(hiddenText, 'the visible field is rendered').toContain('Field: Shown field (shown)')
  expect(hiddenText, 'the visible value is rendered').toContain('Visible value')
  expect(hiddenText, 'the hidden field is absent').not.toContain('Secret field')
  expect(hiddenText, 'the hidden value is absent').not.toContain('Hidden value')

  const registrar = demoInstance((entry) => entry.step === 'registrar')
  const currentStep = await getPdf(readerToken, registrar.id)
  expect(currentStep.status).toBe(200)
  const currentText = await pdfText(await pdfBody(currentStep))
  expect(currentText, 'the registrar step shows no request field').not.toContain('Field: Summary')
  expect(currentText, 'the hidden value is absent from the registrar form').not.toContain(
    'Three extra credits for a graduating student'
  )
})

test('#OU-1 an unknown step answers 404 and the step query renders a named step', async () => {
  const { readerToken } = requireSetup()
  const registrar = demoInstance((entry) => entry.step === 'registrar')
  const unknown = await getPdf(readerToken, registrar.id, 'no-such-step')
  expect(unknown.status, 'the definition has no such step').toBe(404)

  const request = await getPdf(readerToken, registrar.id, 'request')
  expect(request.status, 'the past request step is readable').toBe(200)
  expect(await pdfText(await pdfBody(request))).toContain('Field: Summary (summary)')
})

test('#OU-1 enform admin rebuild leaves the PDF content the same', async () => {
  const { configPath, readerToken } = requireSetup()
  const instance = demoInstance((entry) => entry.step === 'registrar')
  const before = await pdfText(await pdfBody(await getPdf(readerToken, instance.id, 'request')))

  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)

  const after = await pdfText(await pdfBody(await getPdf(readerToken, instance.id, 'request')))
  expect(after, 'the read reproduces the same form and history from the log').toBe(before)
})

test('#OU-1 the instance page offers the generated PDF URL in Chromium', async () => {
  const { browser, publicUrl } = requireSetup()
  const sam = castMember('starter')
  const request = demoInstance((entry) => entry.step === 'request')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signIn(page, publicUrl, sam.email, sam.password)
    await page.goto(
      `${publicUrl}/?flow=${encodeURIComponent(flowSlug())}&instance=${encodeURIComponent(request.id)}`
    )
    const link = page.locator('[data-print-pdf]')
    await link.waitFor({ timeout: 30_000 })
    expect(await link.textContent()).toBe('Print / PDF')
    expect(await link.getAttribute('href')).toBe(`${publicUrl}/api/v1/instances/${request.id}/pdf`)

    const response = await page.request.get(`${publicUrl}/api/v1/instances/${request.id}/pdf`)
    expect(response.status(), 'the browser session opens the PDF').toBe(200)
    expect(response.headers()['content-type']).toContain('application/pdf')
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-')
  } finally {
    await context.close()
  }
})

test('#OU-1 a non-reader gets 403 and no PDF, a missing instance 404', async () => {
  const { config } = requireSetup()
  const outsider = castMember('advisor')
  const token = await passwordToken(config, outsider.email, outsider.password)
  const request = demoInstance((entry) => entry.step === 'request')
  const response = await getPdf(token, request.id)
  expect(response.status, 'the advisor has no read scope on this instance').toBe(403)
  expect(response.headers.get('content-type') ?? '').not.toContain('application/pdf')
  const body = await pdfBody(response)
  expect(body.subarray(0, 5).toString()).not.toBe('%PDF-')

  const missing = await getPdf(token, `missing-${RUN}`)
  expect(missing.status, 'a missing instance is 404').toBe(404)
})

// This test runs last: `seed clear` removes the demo users and records, so the
// tests above must read them first. The administrator is not seeded and keeps
// a valid credential for the request that must answer 404.
test('#OU-1 a cleared seed instance answers 404', async () => {
  const { configPath, adminToken } = requireSetup()
  const request = demoInstance((entry) => entry.step === 'request')
  const cleared = runCli(['seed', 'clear', '--config', configPath, '--yes'])
  expect(cleared.status, cleared.stderr).toBe(0)

  const response = await getPdf(adminToken, request.id)
  expect(response.status, 'the live surface hides a cleared seed instance').toBe(404)
})
