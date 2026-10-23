import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { FlowDefinition } from '../engine/definition.js'
import { json, passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #248, S12, SE-3, SE-4, SE-5, VT-2, I2, I3, I4, I6, ADR 0003, ADR 0011:
// reminders and escalation against the real Compose stack and Mailpit. A step
// sets a one minute reminder interval and a one minute deadline. The start
// schedules two timers, the tracker shows the due time, and the worker fires
// the reminder and the escalation once each and sends them through Mailpit. A
// second instance completes before the deadline, so its timers are cancelled
// and neither email arrives. `enform admin rebuild` reproduces the scheduled,
// fired and cancelled rows and the outbox, and `enform seed clear` removes the
// timers of the demo instances it removes.
//
// The timer is one real minute because the flow contract counts minutes
// (SE-3, SE-4). The suite waits for the real timer, so the proof covers the
// scheduler, the claim, the email hop and the at-most-once rule, not a row
// that the test made due.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `reminders-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'reminders-admin-password'
const REPO = join(import.meta.dirname, '..')
const SLUG = `reminders-${RUN}`
const STEP = 'wait'
const MINUTE = 60_000
const REMINDER = 'send-reminder'
const ESCALATION = 'send-escalation'

/** One seeded instance as `seed demo --json` returns it. */
type DemoInstance = {
  readonly id: string
  readonly step: string
  readonly done: boolean
}

/** The JSON body of `seed demo`. */
type SeedOutput = {
  readonly ok: boolean
  readonly instances?: readonly DemoInstance[]
}

/** One timer row, as the test reads it from PostgreSQL. */
type TimerRow = {
  readonly id: string
  readonly kind: string
  readonly fireAt: number
  readonly cancelledAt: number | null
  readonly firedAt: number | null
  readonly instanceId: string
  readonly step: string
  readonly recipient: string
}

/** One outbox row, as the test reads it from PostgreSQL. */
type OutboxRow = {
  readonly id: string
  readonly effect: string
  readonly status: string
  readonly sentAt: string
  readonly instanceId: string
  readonly payload: string
}

/** One step of the tracker as the instance read returns it (VT-2, SE-4). */
type TrackerStep = {
  readonly key: string
  readonly state: string
  readonly startAt?: number
  readonly dueAt?: number
}

/** The instance read as one actor sees it. */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: { readonly currentStep?: string }
  readonly tracker: readonly TrackerStep[]
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
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly adminId: string
  readonly adminToken: string
  readonly service: EnformProcess
  readonly seed: SeedOutput
  readonly reminderId: string
  readonly cancelledId: string
  readonly reminderAt: number
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-reminders-'))
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
        '--smtp-url',
        config.smtpUrl,
        '--mail-from',
        config.mailFrom,
        '--no-open',
      ],
      publicUrl
    )
    const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
    const adminId = (await readSession(publicUrl, adminToken)).principal.id
    const seeded = runCli(['seed', 'demo', '--config', configPath, '--json'])
    if (seeded.status !== 0) throw new Error(`the demo seed failed: ${seeded.stderr}`)
    const seed = JSON.parse(seeded.stdout) as SeedOutput
    // The helpers below read the shared setup, so the base exists before the
    // flow and the instances are created; the final assignment adds their ids.
    setup = {
      config,
      dir,
      configPath,
      databaseUrl,
      publicUrl,
      adminId,
      adminToken,
      service,
      seed,
      reminderId: '',
      cancelledId: '',
      reminderAt: 0,
    }

    // A flow whose only step sets the timer under test (S12, SE-3, SE-4). The
    // administrator is its starter and its assignee, so one bearer token drives
    // the start, the claim and the completion through the public API.
    const definition: FlowDefinition = {
      schemaVersion: 2,
      steps: [
        {
          key: STEP,
          targets: [{ user: adminId }],
          outcomes: ['approve'],
          reminderMinutes: 1,
          deadlineMinutes: 1,
          escalationTargets: [{ user: adminId }],
        },
      ],
    }
    await adminJson('/api/v1/flows', {
      method: 'POST',
      body: JSON.stringify({ slug: SLUG, title: 'Reminders' }),
    })
    await adminJson(`/api/v1/flows/${SLUG}/draft`, {
      method: 'PUT',
      body: JSON.stringify({ version: 1, definition }),
    })
    await adminJson(`/api/v1/flows/${SLUG}/publish`, {
      method: 'POST',
      body: JSON.stringify({ version: 1 }),
    })
    for (const grant of [
      { principal: adminId, scopes: ['instance.start'], resource: `flow:${SLUG}` },
      {
        principal: adminId,
        scopes: ['step.outcome:approve'],
        resource: `flow:${SLUG}/step:${STEP}`,
      },
    ]) {
      await adminJson('/api/v1/operations', {
        method: 'POST',
        body: JSON.stringify({
          id: randomUUID(),
          type: 'config.grant.changed@1',
          at: Date.now(),
          actor: 'ignored',
          payload: grant,
        }),
      })
    }

    // The instance under test, and one that completes before the deadline.
    const reminderId = randomUUID()
    const started = await postIntent(adminToken, reminderId, {
      flow: SLUG,
      instanceId: reminderId,
      values: {},
    })
    const reminderAt = started.at
    const cancelledId = randomUUID()
    await postIntent(adminToken, cancelledId, {
      flow: SLUG,
      instanceId: cancelledId,
      values: {},
    })
    const view = await readInstance(adminToken, cancelledId)
    if (view.status.currentStep !== STEP) throw new Error('the instance did not reach the step')
    const claimed = await postOperation(adminToken, {
      id: randomUUID(),
      type: 'step.claimed@1',
      at: Date.now(),
      actor: 'ignored',
      payload: { instanceId: cancelledId, expectedVersion: view.version },
    })
    expect(claimed.status, claimed.body).toBe(201)
    const held = await readInstance(adminToken, cancelledId)
    const completed = await postOperation(adminToken, {
      id: randomUUID(),
      type: 'step.completed@1',
      at: Date.now(),
      actor: 'ignored',
      payload: {
        instanceId: cancelledId,
        version: held.version,
        outcome: 'approve',
        values: {},
      },
    })
    expect(completed.status, completed.body).toBe(201)
    await clearMailpit()

    setup = {
      config,
      dir,
      configPath,
      databaseUrl,
      publicUrl,
      adminId,
      adminToken,
      service,
      seed,
      reminderId,
      cancelledId,
      reminderAt,
    }
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

/** The shared setup, or the reason the setup did not run. */
function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/** Run one CLI command synchronously and return its result. */
function runCli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), ...args],
    { cwd: REPO, encoding: 'utf8' }
  )
}

/** Call one API path with the administrator's bearer token. */
async function adminFetch(
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<Response> {
  const { publicUrl, adminToken } = requireSetup()
  const headers: Record<string, string> = { authorization: `Bearer ${adminToken}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${publicUrl}${path}`, { ...init, headers })
}

/** Call one API path and read its JSON body, or name the request that failed. */
async function adminJson<T>(
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<T> {
  return json<T>(await adminFetch(path, init), `${init.method ?? 'GET'} ${path}`)
}

/** Post one operation with a bearer token and return its status and body. */
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

/** Post one start intent and return the event the server appended. */
async function postIntent(
  token: string,
  instanceId: string,
  payload: { readonly flow: string; readonly instanceId: string; readonly values: unknown }
): Promise<{ readonly at: number }> {
  const { publicUrl } = requireSetup()
  const response = await fetch(`${publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: randomUUID(),
      type: 'instance.started@1',
      at: Date.now(),
      actor: 'ignored',
      payload,
    }),
  })
  const body = await response.text()
  if (response.status !== 201) throw new Error(`the start of ${instanceId} failed: ${body}`)
  return JSON.parse(body) as { at: number }
}

/** Read one instance as the administrator. */
async function readInstance(token: string, instanceId: string): Promise<InstanceView> {
  const { publicUrl } = requireSetup()
  const response = await fetch(`${publicUrl}/api/v1/instances/${instanceId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return json<InstanceView>(response, `GET /api/v1/instances/${instanceId}`)
}

/** The timers of one instance, in kind order (SE-3, SE-4). */
function timersOf(instanceId: string): readonly TimerRow[] {
  const { databaseUrl } = requireSetup()
  const columns = `id, kind, fire_at, coalesce(cancelled_at::text, ''), coalesce(fired_at::text, ''),
    coalesce(instance_id, ''), coalesce(step, ''), coalesce(recipient, '')`
  return queryDatabase(
    databaseUrl,
    `select ${columns} from timers where instance_id = '${instanceId}' order by kind, fire_at, id`
  ).map((line) => {
    const [id, kind, fireAt, cancelledAt, firedAt, rowInstance, step, recipient] = line.split('\t')
    return {
      id: id ?? '',
      kind: kind ?? '',
      fireAt: Number(fireAt),
      cancelledAt: cancelledAt === '' ? null : Number(cancelledAt),
      firedAt: firedAt === '' ? null : Number(firedAt),
      instanceId: rowInstance ?? '',
      step: step ?? '',
      recipient: recipient ?? '',
    }
  })
}

/** The outbox rows of one instance, oldest first. */
function outboxRows(instanceId: string): readonly OutboxRow[] {
  const { databaseUrl } = requireSetup()
  const columns = `id, effect, status, coalesce(sent_at::text, ''), coalesce(instance_id, ''),
    payload::text`
  return queryDatabase(
    databaseUrl,
    `select ${columns} from outbox where instance_id = '${instanceId}' order by created_at, seq, id`
  ).map((line) => {
    const [id, effect, status, sentAt, rowInstance, payload] = line.split('\t')
    return {
      id: id ?? '',
      effect: effect ?? '',
      status: status ?? '',
      sentAt: sentAt ?? '',
      instanceId: rowInstance ?? '',
      payload: payload ?? '',
    }
  })
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

/** Empty Mailpit, so one test cannot read another's messages. */
async function clearMailpit(): Promise<void> {
  const { config } = requireSetup()
  await fetch(`${config.mailpitUrl}/api/v1/messages`, { method: 'DELETE' })
}

/** Wait for one condition, or fail with the reason that it never held. */
async function waitFor<T>(what: string, read: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(250)
  }
  throw new Error(`integration: timed out waiting for ${what}`)
}

/** Wait until Mailpit holds a message that matches the predicate. */
function waitForMail(
  what: string,
  match: (message: MailpitMessage) => boolean
): Promise<MailpitMessage> {
  return waitFor(what, async () => (await mailpitMessages()).find(match))
}

/** Start `enform worker` against the test configuration. */
function startWorker(): WorkerChild {
  const { configPath } = requireSetup()
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

/** The app link that every template carries (SE-2). */
function linkOf(instanceId: string): string {
  const { publicUrl } = requireSetup()
  return `${publicUrl}/app/?flow=${encodeURIComponent(SLUG)}&instance=${instanceId}`
}

/** The demo instance at one step, or undefined when the seed has none. */
function demoInstance(step: string): DemoInstance | undefined {
  return requireSetup().seed.instances?.find((instance) => instance.step === step)
}

test('#248 VT-2 SE-4 the start schedules the timers and the tracker shows the due time', async () => {
  const { adminToken, reminderId, cancelledId, reminderAt } = requireSetup()

  const timers = timersOf(reminderId)
  expect(timers.map((timer) => timer.kind)).toEqual(['escalation', 'reminder'])
  for (const timer of timers) {
    expect(timer.step, 'both timers belong to the waiting step').toBe(STEP)
    expect(timer.fireAt, 'a one minute reminder and deadline').toBe(reminderAt + MINUTE)
    expect(timer.cancelledAt, 'the open task has no cancellation').toBeNull()
    expect(timer.firedAt, 'no timer has fired yet').toBeNull()
  }
  expect(timers[0]?.instanceId).toBe(reminderId)
  expect(timers[0]?.recipient, 'the escalation notifies the assignee').not.toBe('')

  // The completed instance's timers are cancelled in the event that completed
  // it, and no side effect of it reaches the outbox (SE-5, I2).
  const cancelled = timersOf(cancelledId)
  expect(cancelled).toHaveLength(2)
  for (const timer of cancelled) expect(timer.cancelledAt).not.toBeNull()
  expect(outboxRows(cancelledId), 'a completion cancels, it does not notify').toEqual([])

  const view = await readInstance(adminToken, reminderId)
  const step = view.tracker.find((entry) => entry.key === STEP)
  expect(step?.state).toBe('unopened')
  expect(step?.startAt, 'the start enters the step').toBe(reminderAt)
  expect(step?.dueAt, 'the tracker carries the deadline (VT-2, SE-4)').toBe(reminderAt + MINUTE)
})

test('#248 SE-3 SE-4 the worker sends the reminder and the escalation once', async () => {
  const { adminId, reminderId } = requireSetup()
  const worker = startWorker()
  try {
    const reminder = await waitForMail('the reminder email', (message) =>
      message.Subject.includes(`reminder (${STEP})`)
    )
    const escalation = await waitForMail('the escalation email', (message) =>
      message.Subject.includes(`escalation (${STEP})`)
    )

    // The reminder and the escalation name the assignee, the step and the
    // link, and the escalation carries the targets it adds (SE-2, SE-3, SE-4).
    for (const message of [reminder, escalation]) {
      expect(
        message.To.map((to) => to.Address),
        'the assignee receives it'
      ).toContain(ADMIN_EMAIL)
      const detail = await mailpitMessage(message.ID)
      expect(detail.Text).toContain(`the ${STEP} step`)
      expect(detail.Text).toContain(linkOf(reminderId))
    }

    // The rows record the firing and the delivery (I2, I3, I4).
    const timers = timersOf(reminderId)
    expect(timers.map((timer) => timer.firedAt !== null)).toEqual([true, true])
    expect(timers.map((timer) => timer.cancelledAt)).toEqual([null, null])
    const outbox = outboxRows(reminderId)
    expect(outbox.map((row) => row.effect).sort()).toEqual([ESCALATION, REMINDER])
    for (const row of outbox) {
      expect(row.status, 'the worker delivered the row').toBe('sent')
      expect(row.sentAt).not.toBe('')
    }
    expect(
      JSON.parse(outbox.find((row) => row.effect === REMINDER)?.payload ?? '{}')
    ).toMatchObject({
      instance: reminderId,
      step: STEP,
      rule: 'reminder',
      occurrence: '1',
      to: adminId,
    })
    expect(
      JSON.parse(outbox.find((row) => row.effect === ESCALATION)?.payload ?? '{}')
    ).toMatchObject({
      instance: reminderId,
      step: STEP,
      rule: 'escalation',
      adds: [`user:${adminId}`],
    })
  } finally {
    await worker.stop()
  }

  // A second worker pass finds no due timer and sends no duplicate (I3).
  const second = startWorker()
  await delay(2_500)
  await second.stop()
  const subjects = (await mailpitMessages()).map((message) => message.Subject)
  expect(subjects.filter((subject) => subject.includes(`reminder (${STEP})`))).toHaveLength(1)
  expect(subjects.filter((subject) => subject.includes(`escalation (${STEP})`))).toHaveLength(1)
  expect(timersOf(reminderId).map((timer) => timer.firedAt !== null)).toEqual([true, true])
})

test('#248 SE-5 I3 the cancelled instance sends no email and a rebuild keeps the state', async () => {
  const { adminToken, configPath, reminderId, cancelledId } = requireSetup()
  const before = { reminder: timersOf(reminderId), cancelled: timersOf(cancelledId) }

  // The completed instance produced no reminder and no escalation: every
  // message carries the open instance's link, never the cancelled one.
  const link = linkOf(cancelledId)
  for (const message of await mailpitMessages()) {
    if (!message.Subject.includes(`(${STEP})`)) continue
    const detail = await mailpitMessage(message.ID)
    expect(detail.Text, 'the cancelled instance sends no email').not.toContain(link)
  }
  expect(outboxRows(cancelledId)).toEqual([])

  // A rebuild folds the start, the firings and the completion back into the
  // same timer rows and keeps the outbox delivery (I3, I4).
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  expect(timersOf(reminderId), 'the fired rows survive the rebuild').toEqual(before.reminder)
  expect(timersOf(cancelledId), 'the cancelled rows survive the rebuild').toEqual(before.cancelled)
  expect(timersOf(reminderId).every((timer) => timer.firedAt !== null)).toBe(true)
  expect(timersOf(cancelledId).every((timer) => timer.cancelledAt !== null)).toBe(true)
  for (const row of outboxRows(reminderId)) expect(row.status).toBe('sent')

  // The completed instance's tracker matches after the rebuild (VT-2).
  const view = await readInstance(adminToken, cancelledId)
  expect(view.tracker.find((entry) => entry.key === STEP)?.state).toBe('completed')
})

test('#248 DE-4 I4 a cleared seed instance loses its timers', () => {
  const { configPath, databaseUrl } = requireSetup()
  const demo = demoInstance('registrar')
  if (demo === undefined) throw new Error('the demo seed has no registrar instance')
  const count = (id: string): number =>
    Number(queryDatabase(databaseUrl, `select count(*) from timers where instance_id = '${id}'`)[0])
  expect(count(demo.id), 'the demo registrar step schedules its timers').toBeGreaterThan(0)
  expect(count(requireSetup().reminderId), 'the live instance keeps its timers').toBeGreaterThan(0)

  const cleared = runCli(['seed', 'clear', '--config', configPath, '--yes'])
  expect(cleared.status, cleared.stderr).toBe(0)
  expect(count(demo.id), 'the clear removes the demo instance timers').toBe(0)
  expect(
    count(requireSetup().reminderId),
    'the clear leaves the live instance alone'
  ).toBeGreaterThan(0)
})
