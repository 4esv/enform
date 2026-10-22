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

// Issue #236, S11, WF-3, AC-4, I4, I5, I8, I12, I14: the send-back journey
// against the real Compose stack. `enform seed demo` loads the demo cast, the
// flow and the in-flight instances. Dr. Okafor, who holds the advisor step,
// returns it to `request` with a comment. Sam sees the task and the comment at
// `request`, resubmits, and the instance goes back to the advisor, where
// Okafor approves it. The note stays on the timeline, and the log holds the
// attributed send back with the actor and the comment.
//
// The test drives the app's own controls and waits on them, never on a fixed
// timeout; the Keycloak login page is the only surface outside the server.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `send-back-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'send-back-admin-password'
const REPO = join(import.meta.dirname, '..')
const COMMENT = 'Attach your degree audit'

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

/** One instance view as `GET /api/v1/instances/{id}` returns it. */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: { readonly currentStep?: string }
  readonly previousSteps: readonly string[]
  readonly notes: readonly {
    readonly step: string
    readonly actor: string
    readonly comment: string
  }[]
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
    const dir = mkdtempSync(join(tmpdir(), 'enform-send-back-'))
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
    if (seeded.status !== 0) {
      throw new Error(`the demo seed failed: ${seeded.stderr}`)
    }
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

test('#236 S11 the holder sends the advisor task back, the requester resubmits, and the advisor approves', async () => {
  const { browser, config, publicUrl, seed } = requireSetup()
  const slug = seed.flow?.slug ?? ''
  const okafor = castMember('advisor')
  const sam = castMember('starter')
  const advisorInstance = seed.instances?.find((instance) => instance.step === 'advisor')
  if (advisorInstance === undefined) throw new Error('the demo seed has no advisor instance')
  const taskUrl = `${publicUrl}/?flow=${encodeURIComponent(slug)}&instance=${encodeURIComponent(advisorInstance.id)}`

  // Okafor claims the advisor task, then the page offers Send back with the
  // earlier steps the read names (S11, WF-3).
  const okaforContext = await browser.newContext()
  const okaforPage = await okaforContext.newPage()
  await signIn(okaforPage, publicUrl, okafor.email, okafor.password)
  await okaforPage.goto(taskUrl)
  await okaforPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
  expect(await okaforPage.textContent('.instance-status')).toContain('Step 3 of 4')
  await okaforPage.click('[data-claim]')
  await okaforPage.waitForFunction(
    () => document.querySelector('.status')?.textContent === 'Claimed'
  )
  await okaforPage.locator('[data-send-back]').waitFor({ timeout: 30_000 })
  const offered = await okaforPage.locator('[data-send-back-step] option').allTextContents()
  expect(offered, 'the read names the earlier steps in definition order').toEqual([
    'chair',
    'request',
  ])

  // The API refuses a raw event and a blank comment before the real send back
  // (WF-3). The engine decides both: the raw shape is a 400 and so is the
  // comment the engine refuses; neither appends an event.
  const okaforToken = await passwordToken(config, okafor.email, okafor.password)
  const held = await json<InstanceView>(
    await fetch(`${publicUrl}/api/v1/instances/${advisorInstance.id}`, {
      headers: { authorization: `Bearer ${okaforToken}` },
    }),
    'GET the advisor instance as Okafor'
  )
  expect(held.previousSteps).toEqual(['chair', 'request'])
  const raw = await fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${okaforToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: randomUUID(),
      type: 'step.sent-back@1',
      at: Date.now(),
      actor: okafor.id,
      payload: {
        instanceId: advisorInstance.id,
        from: 'advisor',
        to: 'request',
        comment: COMMENT,
        revision: 2,
        version: held.version,
      },
    }),
  })
  expect(raw.status, await raw.text()).toBe(400)
  const blank = await fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${okaforToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: randomUUID(),
      type: 'step.sent-back@1',
      at: Date.now(),
      actor: okafor.id,
      payload: {
        instanceId: advisorInstance.id,
        to: 'request',
        comment: '   ',
        version: held.version,
      },
    }),
  })
  expect(blank.status, await blank.text()).toBe(400)

  // The page sends the task back with the comment, then re-reads: the instance
  // is at `request` and the note is on the page.
  await okaforPage.selectOption('[data-send-back-step]', 'request')
  await okaforPage.fill('[data-send-back-comment]', COMMENT)
  await okaforPage.click('[data-send-back]')
  await okaforPage.waitForFunction(() =>
    document.querySelector('.instance-status')?.textContent?.includes('Step 2 of 4')
  )
  const okaforNotes = okaforPage.locator('[data-note]')
  await okaforNotes.first().waitFor({ timeout: 30_000 })
  expect(await okaforNotes.first().textContent()).toContain(COMMENT)
  expect(await okaforNotes.first().textContent()).toContain(okafor.id)

  // The requester's second context opens the same instance. The task is at
  // `request`, and the note to that step is visible (VT-3, I8).
  const samContext = await browser.newContext()
  const samPage = await samContext.newPage()
  await signIn(samPage, publicUrl, sam.email, sam.password)
  await samPage.goto(taskUrl)
  await samPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
  expect(await samPage.textContent('.instance-status')).toContain('Step 2 of 4')
  const samNote = samPage.locator('[data-note]')
  await samNote.first().waitFor({ timeout: 30_000 })
  expect(await samNote.first().textContent()).toContain(COMMENT)
  expect(
    await samPage.locator('[data-send-back]').count(),
    'Sam does not hold the advisor step'
  ).toBe(0)

  // Sam claims and submits again, so the instance returns to the advisor.
  await samPage.click('[data-claim]')
  await samPage.waitForFunction(() => document.querySelector('.status')?.textContent === 'Claimed')
  await samPage.click('[data-outcome="submit"]')
  await samPage.waitForFunction(() =>
    document.querySelector('.instance-status')?.textContent?.includes('Step 3 of 4')
  )

  // Okafor claims the returned advisor task and approves it; the instance
  // advances to the registrar, and the note stays on the page.
  await okaforPage.goto(taskUrl)
  await okaforPage.locator('[data-claim]').waitFor({ timeout: 30_000 })
  await okaforPage.click('[data-claim]')
  await okaforPage.waitForFunction(
    () => document.querySelector('.status')?.textContent === 'Claimed'
  )
  await okaforPage.click('[data-outcome="approve"]')
  await okaforPage.waitForFunction(() =>
    document.querySelector('.instance-status')?.textContent?.includes('Step 4 of 4')
  )
  const finalNotes = okaforPage.locator('[data-note]')
  await finalNotes.first().waitFor({ timeout: 30_000 })
  expect(await finalNotes.first().textContent()).toContain(COMMENT)

  // The log keeps the send back with its actor, its target, its revision and
  // its comment (I4, I14), and the instance read reports the note to the
  // requester (VT-3).
  const log = await json<readonly Event[]>(
    await fetch(`${publicUrl}/api/v1/log`, {
      headers: { authorization: `Bearer ${okaforToken}` },
    }),
    'GET the log as Okafor'
  )
  const sent = log.find(
    (event) => event.type === 'step.sent-back@1' && event.payload.instanceId === advisorInstance.id
  )
  expect(sent).toMatchObject({
    actor: okafor.id,
    payload: {
      instanceId: advisorInstance.id,
      from: 'advisor',
      to: 'request',
      comment: COMMENT,
      revision: 2,
    },
  })

  const samRead = await json<InstanceView>(
    await fetch(`${publicUrl}/api/v1/instances/${advisorInstance.id}`, {
      headers: { authorization: `Bearer ${await passwordToken(config, sam.email, sam.password)}` },
    }),
    'GET the instance as Sam'
  )
  expect(samRead.notes).toContainEqual({ step: 'request', actor: okafor.id, comment: COMMENT })

  // The projection records the target step's revision (WF-3), and a rebuild
  // folds the same event back into it (I4): the instance stays at the
  // registrar, the note stays, and revision 2 survives.
  expect(
    queryDatabase(
      requireSetup().databaseUrl,
      `select revisions->>'request' from instances where id = '${advisorInstance.id}'`
    )[0],
    'the send back recorded revision 2 on request'
  ).toBe('2')
  const rebuilt = runCli(['admin', 'rebuild', '--config', requireSetup().configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  const samAfterRebuild = await json<InstanceView>(
    await fetch(`${publicUrl}/api/v1/instances/${advisorInstance.id}`, {
      headers: { authorization: `Bearer ${await passwordToken(config, sam.email, sam.password)}` },
    }),
    'GET the rebuilt instance as Sam'
  )
  expect(samAfterRebuild.status.currentStep).toBe('registrar')
  expect(samAfterRebuild.previousSteps).toEqual(['chair', 'request', 'advisor'])
  expect(samAfterRebuild.notes).toContainEqual({
    step: 'request',
    actor: okafor.id,
    comment: COMMENT,
  })
  expect(
    queryDatabase(
      requireSetup().databaseUrl,
      `select revisions->>'request' from instances where id = '${advisorInstance.id}'`
    )[0],
    'the rebuild reproduces revision 2'
  ).toBe('2')
}, 180_000)
