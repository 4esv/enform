import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #240, SE-1, SE-2, I2, I3, I4, ADR 0003: deliver the outbox through a
// real SMTP server. `enform init` writes the SMTP configuration, `enform seed
// demo` records an assignment email on the submit event, and the worker sends
// it to Mailpit. The test then proves the row is sent, a rebuild keeps the
// delivery status, a second worker pass sends no duplicate, a send back and a
// withdrawal produce their own templates, a missing SMTP configuration leaves
// the row queued without crashing the worker, and a refused connection records
// the attempt count, the last error and a backoff.
//
// The assignment emails come from the demo seed's submits and completions
// (ADR 0014, SE-2): the submit notifies the advisor, and the advisor's
// completion notifies each registrar team member, so the seed is
// the product path that records it today.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `mail-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'mail-admin-password-240'
const REPO = join(import.meta.dirname, '..')

/** One demo user as `seed demo --json` returns it. */
type DemoUser = {
  readonly role: string
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

/** One outbox row, as the test reads it from PostgreSQL. */
type OutboxRow = {
  readonly id: string
  readonly effect: string
  readonly status: string
  readonly attempts: number
  readonly payload: string
  readonly instanceId: string
  readonly flowSlug: string
  readonly sentAt: string
  readonly nextAttemptAt: string
  readonly lastError: string
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
  readonly stderr: () => string
  readonly stop: () => Promise<void>
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly configNoMail: string
  readonly configBadMail: string
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly seed: SeedOutput
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-mail-'))
    const databaseUrl = databaseUrlForRun(config.databaseUrl)
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const configPath = join(dir, 'enform.toml')
    const configNoMail = join(dir, 'no-mail.toml')
    const configBadMail = join(dir, 'bad-mail.toml')

    const service = await startEnform(
      initArgs(config, configPath, databaseUrl, publicUrl, config.smtpUrl),
      publicUrl
    )
    const seeded = runCli(['seed', 'demo', '--config', configPath, '--json'])
    if (seeded.status !== 0) throw new Error(`the demo seed failed: ${seeded.stderr}`)
    setup = {
      config,
      dir,
      configPath,
      configNoMail,
      configBadMail,
      databaseUrl,
      publicUrl,
      service,
      seed: JSON.parse(seeded.stdout) as SeedOutput,
    }
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

/** The shared setup, or the reason that `enform init` did not produce it. */
function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/** The arguments of `enform init` for one configuration file. */
function initArgs(
  config: TestConfig,
  configPath: string,
  databaseUrl: string,
  publicUrl: string,
  smtpUrl: string
): readonly string[] {
  return [
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
    smtpUrl,
    '--mail-from',
    config.mailFrom,
    '--no-open',
  ]
}

/** Run one CLI command synchronously and return its result. */
function runCli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), ...args],
    { cwd: REPO, encoding: 'utf8' }
  )
}

/** Read every outbox row, oldest first. */
function outboxRows(): readonly OutboxRow[] {
  const { databaseUrl } = requireSetup()
  const columns = `id, effect, status, attempts, payload::text, coalesce(instance_id, ''),
    coalesce(flow_slug, ''), coalesce(sent_at::text, ''), next_attempt_at::text,
    coalesce(last_error, '')`
  return queryDatabase(
    databaseUrl,
    `select ${columns} from outbox order by created_at, seq, id`
  ).map((line) => {
    const [id, effect, status, attempts, payload, instanceId, flowSlug, sentAt, next, last] =
      line.split('\t')
    return {
      id,
      effect,
      status,
      attempts: Number(attempts),
      payload,
      instanceId,
      flowSlug,
      sentAt,
      nextAttemptAt: next,
      lastError: last,
    }
  })
}

/** One outbox row by effect, or the reason it is absent. */
function outboxRow(effect: string): OutboxRow {
  const row = outboxRows().find((candidate) => candidate.effect === effect)
  if (row === undefined) throw new Error(`the outbox has no ${effect} row`)
  return row
}

/** The version of one instance, read from the projection (I5). */
function instanceVersion(instanceId: string): number {
  const { databaseUrl } = requireSetup()
  const [value] = queryDatabase(
    databaseUrl,
    `select version from instances where id = '${instanceId}'`
  )
  return Number(value)
}

/** One demo user by role, or the reason the seed did not carry it. */
function castMember(role: string): DemoUser {
  const user = requireSetup().seed.users?.find((entry) => entry.role === role)
  if (user === undefined) throw new Error(`the demo seed has no ${role}`)
  return user
}

/** Every demo user with one role (the registrar team has two). */
function castMembers(role: string): readonly DemoUser[] {
  return (requireSetup().seed.users ?? []).filter((entry) => entry.role === role)
}

/** The assignment rows that name one step, in outbox order (SE-2). */
function assignmentRows(step: string): readonly OutboxRow[] {
  return outboxRows().filter(
    (row) => row.effect === 'send-assignment' && JSON.parse(row.payload).step === step
  )
}

/** One seeded instance by step, or the reason the seed did not carry it. */
function seededInstance(step: string): DemoInstance {
  const instance = requireSetup().seed.instances?.find((entry) => entry.step === step)
  if (instance === undefined) throw new Error(`the demo seed has no instance at ${step}`)
  return instance
}

/** Sign one demo user in and cache their profile, including the email the worker resolves. */
async function signIn(user: DemoUser): Promise<string> {
  const { config, publicUrl } = requireSetup()
  const token = await passwordToken(config, user.email, user.password)
  await readSession(publicUrl, token)
  return token
}

/** Post one operation as a signed-in user and return the response body. */
async function postOperation(
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: string }> {
  const { publicUrl } = requireSetup()
  const response = await fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
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

/** Wait until one outbox row holds a status, or fail with the row. */
function waitForStatus(effect: string, status: string): Promise<OutboxRow> {
  return waitFor(`${effect} to be ${status}`, async () => {
    const row = outboxRows().find((candidate) => candidate.effect === effect)
    return row?.status === status ? row : undefined
  })
}

/** Wait until Mailpit holds a message that matches the predicate. */
function waitForMail(
  what: string,
  match: (message: MailpitMessage) => boolean
): Promise<MailpitMessage> {
  return waitFor(what, async () => (await mailpitMessages()).find(match))
}

/** Start `enform worker` against one configuration file. */
function startWorker(configPath: string): WorkerChild {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), 'worker', '--config', configPath],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(10_000).then(() => child.kill('SIGKILL'))])
  }
  return { child, stderr: () => stderr, stop }
}

/** Empty Mailpit, so one run cannot read another run's messages. */
async function clearMailpit(): Promise<void> {
  const { config } = requireSetup()
  await fetch(`${config.mailpitUrl}/api/v1/messages`, { method: 'DELETE' })
}

test('#240 I2 I4 the submit projects one queued assignment row with the recipient and link', async () => {
  const { seed } = requireSetup()
  await clearMailpit()
  // The worker resolves the recipient through the principals projection, so
  // the recipient must have signed in once. That is the normal order: a
  // person who follows the link has a cached directory profile. The seed also
  // queued the registrar team's assignment emails, so both registrars sign in.
  await signIn(castMember('advisor'))
  for (const registrar of castMembers('registrar')) await signIn(registrar)

  const row = outboxRow('send-assignment')
  expect(row.status).toBe('queued')
  expect(row.attempts).toBe(0)
  expect(row.sentAt).toBe('')
  expect(row.instanceId).toBe(seededInstance('advisor').id)
  expect(row.flowSlug).toBe(seed.flow?.slug)
  expect(row.payload).toContain(castMember('advisor').id)
  expect(JSON.parse(row.payload)).toMatchObject({ step: 'advisor' })
})

test('#240 SE-1 SE-2 the worker sends the assignment email through Mailpit', async () => {
  const { configPath, publicUrl, seed } = requireSetup()
  const advisor = castMember('advisor')
  const worker = startWorker(configPath)
  try {
    const row = await waitForStatus('send-assignment', 'sent')
    expect(row.attempts, 'one successful attempt').toBe(1)
    expect(row.sentAt).not.toBe('')

    // Three demo instances were submitted, so three assignment emails name
    // the advisor step; the one for the instance waiting at advisor carries
    // that instance's link.
    const instanceId = seededInstance('advisor').id
    const link = `${publicUrl}/app/?flow=${encodeURIComponent(seed.flow?.slug ?? '')}&instance=${instanceId}`
    const detail = await waitFor('the assignment email of the advisor instance', async () => {
      for (const candidate of await mailpitMessages()) {
        if (!candidate.Subject.includes('task assigned (advisor)')) continue
        const read = await mailpitMessage(candidate.ID)
        if (read.Text.includes(link)) return read
      }
      return undefined
    })
    expect(detail.To.map((to) => to.Address)).toContain(advisor.email)
    expect(detail.Text, 'the template carries no form value').not.toContain('Three extra credits')
    expect(detail.HTML).toContain(link.replace(/&/g, '&amp;'))
  } finally {
    await worker.stop()
  }
})

test('#240 I3 I4 a rebuild keeps the delivery status and a second pass sends no duplicate', async () => {
  const { configPath, databaseUrl } = requireSetup()
  const before = outboxRow('send-assignment')
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  const after = outboxRows().find((row) => row.id === before.id)
  expect(after, 'the rebuild re-creates the row with the same deterministic id').toBeDefined()
  expect(after?.status, 'a delivered row stays delivered across a rebuild').toBe('sent')
  expect(after?.attempts).toBe(1)

  // Three demo instances were submitted, so the advisor got three assignment
  // emails, one per row (SE-2); the worker delivered every assignment row.
  const advisorRows = assignmentRows('advisor')
  const countBefore = (await mailpitMessages()).filter((message) =>
    message.Subject.includes('task assigned (advisor)')
  ).length
  expect(countBefore).toBe(advisorRows.length)

  const worker = startWorker(configPath)
  await delay(2_500)
  await worker.stop()
  const countAfter = (await mailpitMessages()).filter((message) =>
    message.Subject.includes('task assigned (advisor)')
  ).length
  expect(countAfter, 'the sent rows are not delivered again (I3)').toBe(advisorRows.length)
  expect(outboxRow('send-assignment').status).toBe('sent')
  expect(queryDatabase(databaseUrl, "select count(*) from outbox where status = 'sent'")[0]).toBe(
    String(assignmentRows('advisor').length + assignmentRows('registrar').length)
  )
})

test('#240 SE-2 a send back delivers its own template', async () => {
  const { configPath, publicUrl, seed } = requireSetup()
  const starter = castMember('starter')
  const advisor = castMember('advisor')
  const advisorToken = await signIn(advisor)
  await signIn(starter)
  const instanceId = seededInstance('advisor').id
  const before = instanceVersion(instanceId)

  const claimed = await postOperation(advisorToken, {
    id: randomUUID(),
    type: 'step.claimed@1',
    at: Date.now(),
    payload: { instanceId, expectedVersion: before },
  })
  expect(claimed.status, claimed.body).toBe(201)

  const sentBack = await postOperation(advisorToken, {
    id: randomUUID(),
    type: 'step.sent-back@1',
    at: Date.now(),
    payload: {
      instanceId,
      to: 'request',
      comment: 'Attach your degree audit',
      version: instanceVersion(instanceId),
    },
  })
  expect(sentBack.status, sentBack.body).toBe(201)

  const row = outboxRow('send-sent-back')
  expect(row.status).toBe('queued')
  expect(row.instanceId).toBe(instanceId)
  expect(row.flowSlug).toBe(seed.flow?.slug)

  const worker = startWorker(configPath)
  try {
    await waitForStatus('send-sent-back', 'sent')
    const message = await waitForMail('the sent-back email', (candidate) =>
      candidate.Subject.includes('task sent back (request)')
    )
    expect(message.To.map((to) => to.Address)).toContain(starter.email)
    const detail = await mailpitMessage(message.ID)
    expect(detail.Text).toContain('Attach your degree audit')
    expect(detail.Text).toContain(
      `${publicUrl}/app/?flow=${encodeURIComponent(seed.flow?.slug ?? '')}&instance=${instanceId}`
    )
  } finally {
    await worker.stop()
  }
})

test('#240 SE-2 a withdrawal delivers the withdrawn-or-cancelled template', async () => {
  const { configPath, publicUrl, seed } = requireSetup()
  const starter = castMember('starter')
  const starterToken = await signIn(starter)
  // The request instance is Sam's unsubmitted draft (ADR 0014); withdrawing
  // it discards the draft and notifies its only assignee, Sam himself.
  const instanceId = seededInstance('request').id
  const withdrawn = await postOperation(starterToken, {
    id: randomUUID(),
    type: 'instance.withdrawn@1',
    at: Date.now(),
    payload: { instanceId, reason: 'Dropped a class', version: instanceVersion(instanceId) },
  })
  expect(withdrawn.status, withdrawn.body).toBe(201)
  expect(outboxRow('send-withdrawn-cancelled').status).toBe('queued')

  const worker = startWorker(configPath)
  try {
    await waitForStatus('send-withdrawn-cancelled', 'sent')
    const message = await waitForMail('the withdrawn email', (candidate) =>
      candidate.Subject.includes('task withdrawn or cancelled (request)')
    )
    expect(message.To.map((to) => to.Address)).toContain(starter.email)
    const detail = await mailpitMessage(message.ID)
    expect(detail.Text).toContain('Dropped a class')
    expect(detail.Text).toContain(
      `${publicUrl}/app/?flow=${encodeURIComponent(seed.flow?.slug ?? '')}&instance=${instanceId}`
    )
  } finally {
    await worker.stop()
  }
})

test('#240 SE-1 a missing SMTP configuration leaves the outbox queued and the worker alive', async () => {
  const { config, configNoMail, databaseUrl, publicUrl } = requireSetup()
  const init = runCli([...initArgs(config, configNoMail, databaseUrl, publicUrl, ''), '--no-serve'])
  expect(init.status, init.stderr).toBe(0)
  const effect = 'send-withdrawn-cancelled'
  queryDatabase(
    databaseUrl,
    `update outbox set status = 'queued', attempts = 0, next_attempt_at = 0,
       sent_at = null, delivered_at = null, last_error = null where effect = '${effect}'`
  )

  const worker = startWorker(configNoMail)
  await delay(2_500)
  expect(worker.child.exitCode, 'the worker does not crash without SMTP').toBeNull()
  expect(worker.stderr()).toContain('SMTP is not configured')
  expect(outboxRow(effect).status).toBe('queued')
  await worker.stop()
})

test('#240 SE-1 a refused connection records the attempt, the error and the backoff', async () => {
  const { config, configBadMail, databaseUrl, publicUrl } = requireSetup()
  const bad = runCli([
    ...initArgs(config, configBadMail, databaseUrl, publicUrl, 'smtp://127.0.0.1:1'),
    '--no-serve',
  ])
  expect(bad.status, bad.stderr).toBe(0)
  const effect = 'send-withdrawn-cancelled'
  queryDatabase(
    databaseUrl,
    `update outbox set status = 'queued', attempts = 0, next_attempt_at = 0,
       sent_at = null, delivered_at = null, last_error = null where effect = '${effect}'`
  )
  const before = Date.now()
  const worker = startWorker(configBadMail)
  try {
    const row = await waitFor('the first failed attempt', async () => {
      const found = outboxRows().find((candidate) => candidate.effect === effect)
      return found !== undefined && found.attempts >= 1 ? found : undefined
    })
    expect(row.status).toBe('failed')
    expect(row.lastError).not.toBe('')
    expect(Number(row.nextAttemptAt), 'the row is due again after a backoff').toBeGreaterThan(
      before + 500
    )
  } finally {
    await worker.stop()
  }
})

// Issue #269, SE-1, I4, I8, I14: a flow owner sends a message again. The
// instance's messages read back with their status, a person who is not a
// flow owner may not resend, the owner's resend re-queues the row, records
// one attributed `mail.resent@1` event, and the worker delivers it a second
// time through Mailpit. The task page shows each message's status and the
// Send again control to the owner. Expected to fail until the route and the
// page exist.

test('#269 SE-1 a flow owner sends a delivered message again, and the page shows each message', async () => {
  const { configPath, publicUrl, config } = requireSetup()
  // The registrar instance: its assignment went to the registrar team, whose
  // members may read it and hold no task.reassign (I8).
  const instanceId = seededInstance('registrar').id
  const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  const registrarToken = await signIn(castMember('registrar'))
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })

  // The messages of the instance, with their status (SE-1).
  const listed = await fetch(`${publicUrl}/api/v1/instances/${instanceId}/mail`, {
    headers: headers(registrarToken),
  })
  expect(listed.status, await listed.clone().text()).toBe(200)
  const rows = (await listed.json()) as readonly {
    id: string
    effect: string
    step?: string
    status: string
    attempts: number
  }[]
  // The instance passed the advisor step first; the registrar assignment is
  // the one whose second delivery the count below watches.
  const assignment = rows.find(
    (row) => row.effect === 'send-assignment' && row.step === 'registrar' && row.status === 'sent'
  )
  expect(assignment, 'a sent registrar assignment email is listed').toBeDefined()
  if (assignment === undefined) throw new Error('no sent assignment row')

  // The registrar is not a flow owner: refused (I8).
  const refused = await fetch(
    `${publicUrl}/api/v1/instances/${instanceId}/mail/${assignment.id}/resend`,
    { method: 'POST', headers: headers(registrarToken) }
  )
  expect(refused.status).toBe(403)

  // The administrator holds org.grants: the row is queued again and the log
  // records the resend (I14).
  const resent = await fetch(
    `${publicUrl}/api/v1/instances/${instanceId}/mail/${assignment.id}/resend`,
    { method: 'POST', headers: headers(adminToken) }
  )
  expect(resent.status, await resent.clone().text()).toBe(200)
  expect(outboxRows().find((row) => row.id === assignment.id)?.status).toBe('queued')
  const logged = queryDatabase(
    requireSetup().databaseUrl,
    `select count(*) from events where type = 'mail.resent@1' and payload->>'mailId' = '${assignment.id}'`
  )
  expect(logged[0]).toBe('1')

  // The worker sends it again: a second assignment email for the instance.
  const before = (await mailpitMessages()).filter((message) =>
    message.Subject.includes('task assigned (registrar)')
  ).length
  const worker = startWorker(configPath)
  try {
    await waitFor('the resent row to be sent again', async () => {
      const row = outboxRows().find((candidate) => candidate.id === assignment.id)
      return row?.status === 'sent' ? row : undefined
    })
    await waitFor('a second assignment email', async () => {
      const count = (await mailpitMessages()).filter((message) =>
        message.Subject.includes('task assigned (registrar)')
      ).length
      return count > before ? count : undefined
    })
  } finally {
    await worker.stop()
  }

  // The task page lists the message with its status and offers Send again to
  // the owner (SE-1, A4).
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const session = await page.request.get(`${publicUrl}/api/v1/session`)
    await page.goto(publicUrl)
    if (session.status() === 401) {
      await page.locator('#username').waitFor({ timeout: 30_000 })
      await page.fill('#username', ADMIN_EMAIL)
      await page.fill('#password', ADMIN_PASSWORD)
      await page.click('#kc-login')
    }
    await page.locator('.app-header').waitFor({ timeout: 30_000 })
    await page.goto(
      `${publicUrl}/?flow=${encodeURIComponent(requireSetup().seed.flow?.slug ?? '')}&instance=${instanceId}`
    )
    const mailRow = page.locator(`[data-mail-row="${assignment.id}"]`)
    await mailRow.waitFor({ timeout: 30_000 })
    expect(await mailRow.getAttribute('data-mail-status')).toBe('sent')
    expect(await mailRow.locator('[data-mail-resend]').count()).toBe(1)
  } finally {
    await browser.close()
  }
}, 180_000)

// Issue #269, SE-2, I8: the templates page. An administrator reads each
// event type's template with its variables and a preview, through the API
// and on the page; a person without org.grants is refused. Expected to fail
// until the route and the page exist.

test('#269 SE-2 the templates page shows each event type with its variables and a preview', async () => {
  const { publicUrl, config } = requireSetup()
  const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  const registrarToken = await signIn(castMember('registrar'))
  const refused = await fetch(`${publicUrl}/api/v1/admin/templates`, {
    headers: { authorization: `Bearer ${registrarToken}` },
  })
  expect(refused.status).toBe(403)
  const listed = await fetch(`${publicUrl}/api/v1/admin/templates`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  expect(listed.status, await listed.clone().text()).toBe(200)
  const templates = (await listed.json()) as readonly {
    effect: string
    variables: readonly string[]
    preview: { subject: string; text: string }
  }[]
  expect(templates.length).toBeGreaterThanOrEqual(8)
  const assignment = templates.find((template) => template.effect === 'send-assignment')
  expect(assignment?.preview.subject).toContain('task assigned')
  expect(assignment?.preview.text).toContain(publicUrl)

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const session = await page.request.get(`${publicUrl}/api/v1/session`)
    await page.goto(publicUrl)
    if (session.status() === 401) {
      await page.locator('#username').waitFor({ timeout: 30_000 })
      await page.fill('#username', ADMIN_EMAIL)
      await page.fill('#password', ADMIN_PASSWORD)
      await page.click('#kc-login')
    }
    await page.locator('.app-header').waitFor({ timeout: 30_000 })
    await page.goto(`${publicUrl}/?templates=1`)
    await page.locator('[data-template="send-assignment"]').waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-template]').count()).toBeGreaterThanOrEqual(8)
    expect(
      await page.locator('[data-template="send-assignment"] [data-template-subject]').textContent()
    ).toContain('task assigned')
  } finally {
    await browser.close()
  }
}, 120_000)
