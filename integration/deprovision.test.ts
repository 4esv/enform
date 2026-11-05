import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, keycloakAdminToken, passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #267, S08, ID-4, ID-5, ID-6, AS-1, AS-4, AS-5, I4, I8, I10, I14, WF-5:
// identity against the real stack. A `manager-of:starter` target resolves to
// the manager the directory names at the submit (AS-1, I13). An
// administrator deprovisions the manager through the API: the account is
// disabled in Keycloak, the task he held returns to the pool through
// `task.released@1` with the reason, and the log records the account. A
// later submit that names him routes to the Unroutable queue with the owner
// alert (I10). The worker's scheduled synchronization deprovisions a person
// Keycloak disabled and provisions them again once enabled, and the CLI
// runs the same pass and the same deprovision.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `identity-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'identity-admin-password'
const REPO = join(import.meta.dirname, '..')
const ENTRY = join(REPO, 'cli', 'main.ts')

const MANAGER_SLUG = `manager-flow-${RUN}`
const LEAVER_SLUG = `leaver-flow-${RUN}`

/** One user the test creates through the enform API (ID-6). */
type Person = {
  readonly id: string
  readonly email: string
  readonly token: string
  readonly password: string
}

/** One event of the log as `GET /api/v1/log` answers it. */
type LogEvent = {
  readonly seq: number
  readonly type: string
  readonly actor?: string
  readonly payload: Record<string, unknown>
}

type InstanceView = {
  readonly version: number
  readonly status: {
    readonly currentStep?: string
    readonly holder?: string
    readonly queue?: string
    readonly state: string
  }
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly adminToken: string
  readonly adminId: string
  readonly service: EnformProcess
  readonly manager: Person
  readonly starter: Person
  readonly leaver: Person
  readonly owner: Person
}

let setup: Setup | undefined
let setupError: unknown

/** The instances the tests start, shared by the later checks. */
const instances = {
  managed: randomUUID(),
  unroutable: randomUUID(),
  left: randomUUID(),
}

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-identity-'))
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
    const admin = await readSession(publicUrl, adminToken)
    const base = { config, publicUrl, adminToken }

    const manager = await person(base, 'manager')
    // The starter's manager is a directory attribute the create records (AS-1).
    const starter = await person(base, 'starter', manager.id)
    const leaver = await person(base, 'leaver')
    const owner = await person(base, 'owner')

    setup = {
      config,
      dir,
      configPath,
      databaseUrl,
      publicUrl,
      adminToken,
      adminId: admin.principal.id,
      service,
      manager,
      starter,
      leaver,
      owner,
    }

    const request = { key: 'request', targets: [{ starter: 'starter' }] }
    await publishFlow(MANAGER_SLUG, {
      schemaVersion: 2,
      steps: [
        request,
        { key: 'manager', targets: [{ 'manager-of': 'starter' }], outcomes: ['approve'] },
      ],
    })
    await publishFlow(LEAVER_SLUG, {
      schemaVersion: 2,
      steps: [request, { key: 'review', targets: [{ user: leaver.id }], outcomes: ['approve'] }],
    })
    for (const slug of [MANAGER_SLUG, LEAVER_SLUG]) {
      await grant(owner.id, `flow:${slug}`, ['task.reassign', 'instance.read'])
      await grant(starter.id, `flow:${slug}`, ['instance.start'])
    }
    await grant(manager.id, `flow:${MANAGER_SLUG}/step:manager`, ['step.outcome:approve'])
    await grant(leaver.id, `flow:${LEAVER_SLUG}/step:review`, ['step.outcome:approve'])
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  if (setup !== undefined && process.env.ENFORM_TEST_STDERR === '1') {
    process.stderr.write(setup.service.stderr())
  }
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/**
 * Create one user through `POST /api/v1/admin/users` (ID-6, #267), with the
 * manager when the test names one, and sign the user in with the one-time
 * password the create answers.
 */
async function person(
  base: { readonly config: TestConfig; readonly publicUrl: string; readonly adminToken: string },
  name: string,
  managerId?: string
): Promise<Person> {
  const email = `${name}-${RUN}@test.local`
  const response = await fetch(`${base.publicUrl}/api/v1/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${base.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      displayName: `${name} Person`,
      sendInvite: false,
      ...(managerId === undefined ? {} : { managerId }),
    }),
  })
  const created = await json<{ id: string; temporaryPassword: string; managerId?: string }>(
    response,
    `creating ${name}`
  )
  expect(created.managerId).toBe(managerId)
  const token = await passwordToken(base.config, email, created.temporaryPassword)
  await readSession(base.publicUrl, token)
  return { id: created.id, email, token, password: created.temporaryPassword }
}

type Call = {
  readonly method?: string
  readonly body?: string
}

function personFetch(token: string, path: string, init: Call = {}): Promise<Response> {
  const { publicUrl } = requireSetup()
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${publicUrl}${path}`, { ...init, headers })
}

function adminFetch(path: string, init: Call = {}): Promise<Response> {
  return personFetch(requireSetup().adminToken, path, init)
}

async function adminJson<T>(path: string, init: Call = {}): Promise<T> {
  return json<T>(await adminFetch(path, init), `${init.method ?? 'GET'} ${path}`)
}

async function publishFlow(
  slug: string,
  definition: { readonly schemaVersion: 2; readonly steps: readonly Record<string, unknown>[] }
): Promise<void> {
  await adminJson('/api/v1/flows', { method: 'POST', body: JSON.stringify({ slug, title: slug }) })
  await adminJson(`/api/v1/flows/${slug}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ version: 1, definition }),
  })
  await adminJson(`/api/v1/flows/${slug}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  })
}

async function grant(
  principal: string,
  resource: string,
  scopes: readonly string[]
): Promise<void> {
  await adminJson('/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      type: 'config.grant.changed@1',
      at: Date.now(),
      actor: requireSetup().adminId,
      payload: { principal, resource, scopes },
    }),
  })
}

/** Post one client intent as one person (ADR 0010). */
async function postIntent(token: string, body: Record<string, unknown>): Promise<Response> {
  return personFetch(token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), at: Date.now(), ...body }),
  })
}

/** Start one flow as the starter and submit the draft, so the next step routes (ADR 0014). */
async function startAndSubmit(slug: string, instanceId: string): Promise<void> {
  const { starter } = requireSetup()
  await json(
    await postIntent(starter.token, {
      type: 'instance.started@1',
      actor: starter.id,
      payload: { flow: slug, instanceId, values: {} },
    }),
    `starting ${slug}`
  )
  await json(
    await postIntent(starter.token, {
      type: 'instance.submitted@1',
      actor: starter.id,
      payload: { instanceId, version: 0, values: {} },
    }),
    `submitting ${slug}`
  )
}

async function readInstance(token: string, instanceId: string): Promise<InstanceView> {
  return json<InstanceView>(
    await personFetch(token, `/api/v1/instances/${instanceId}`),
    `reading ${instanceId}`
  )
}

async function claim(token: string, actor: string, instanceId: string): Promise<void> {
  const view = await readInstance(token, instanceId)
  const response = await postIntent(token, {
    type: 'step.claimed@1',
    actor,
    payload: { instanceId, expectedVersion: view.version },
  })
  expect(response.status, await response.text()).toBe(201)
}

async function inboxIds(token: string, tab: string): Promise<readonly string[]> {
  const items = await json<readonly { instanceId: string }[]>(
    await personFetch(token, `/api/v1/inbox?tab=${tab}`),
    `GET the ${tab} inbox`
  )
  return items.map((item) => item.instanceId)
}

/** The whole log, as the administrator reads it (I8). */
async function wholeLog(): Promise<readonly LogEvent[]> {
  return adminJson<readonly LogEvent[]>('/api/v1/log')
}

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await read()
    if (found !== undefined) return found
    await delay(500)
  }
  throw new Error(`${what} did not appear within ${timeoutMs} ms`)
}

/** Run one CLI command as one signed-in person, with `--json` against the test server. */
function enform(
  person: string,
  args: readonly string[]
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const { publicUrl, dir } = requireSetup()
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', ENTRY, ...args, '--server', publicUrl, '--json'],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ENFORM_CREDENTIALS: join(dir, `${person}-credentials.json`) },
    }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Run one local service command of the CLI against the test configuration. */
function enformLocal(args: readonly string[]): {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
} {
  const { configPath } = requireSetup()
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', ENTRY, ...args, '--config', configPath, '--json'],
    { cwd: REPO, encoding: 'utf8' }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Enable or disable one user straight in Keycloak, as a directory change would (ID-5). */
async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const { config } = requireSetup()
  const token = await keycloakAdminToken(config)
  const base = `${config.keycloakUrl}/admin/realms/${encodeURIComponent(config.realm)}/users/${id}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const current = await json<Record<string, unknown>>(
    await fetch(base, { headers }),
    `reading ${id}`
  )
  const response = await fetch(base, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...current, enabled }),
  })
  if (!response.ok) throw new Error(`setting ${id} enabled=${enabled} failed: ${response.status}`)
}

/** A worker child and the way to stop it. */
type WorkerChild = { readonly child: ChildProcess; readonly stop: () => Promise<void> }

/** Run the real worker with a one-second directory synchronization (ID-5). */
function startWorker(): WorkerChild {
  const { configPath } = requireSetup()
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      ENTRY,
      'worker',
      '--config',
      configPath,
      '--directory-sync-seconds',
      '1',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(10_000).then(() => child.kill('SIGKILL'))])
  }
  return { child, stop }
}

/** One task row's queue, read from the projection. */
function taskQueue(instanceId: string): string {
  const { databaseUrl } = requireSetup()
  const row = queryDatabase(
    databaseUrl,
    `select coalesce(queue, '') from tasks where instance_id = '${instanceId}' order by seq desc limit 1`
  )[0]
  if (row === undefined) throw new Error(`the task of ${instanceId} is absent`)
  return row
}

test('#267 S08 AS-1 manager-of:starter resolves to the manager the directory names, who claims the task', async () => {
  const { manager, starter } = requireSetup()
  const users =
    await adminJson<readonly { id: string; managerId?: string }[]>('/api/v1/admin/users')
  expect(
    users.find((user) => user.id === starter.id)?.managerId,
    'the directory names the manager'
  ).toBe(manager.id)

  await startAndSubmit(MANAGER_SLUG, instances.managed)
  expect(await inboxIds(manager.token, 'available'), 'the manager sees the task').toContain(
    instances.managed
  )
  const view = await readInstance(manager.token, instances.managed)
  expect(view.status.currentStep).toBe('manager')
  expect(view.status.queue).toBeUndefined()
  await claim(manager.token, manager.id, instances.managed)
  expect((await readInstance(manager.token, instances.managed)).status.holder).toBe(manager.id)
})

test('#267 ID-5 an administrator deprovisions the manager: the account is disabled, the task returns to the pool with the reason, and the log records it', async () => {
  const { config, manager, owner, adminId } = requireSetup()
  const response = await adminFetch(`/api/v1/admin/users/${manager.id}/deprovision`, {
    method: 'POST',
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toEqual({
    principal: manager.id,
    released: [{ instanceId: instances.managed, step: 'manager' }],
  })

  // The task is back in the pool (A1), and the timeline says why (WF-5, VT-5).
  const view = await readInstance(owner.token, instances.managed)
  expect(view.status.holder).toBeUndefined()
  expect(view.status.currentStep).toBe('manager')
  const log = await wholeLog()
  const release = log.find(
    (event) => event.type === 'task.released@1' && event.payload.instanceId === instances.managed
  )
  expect(release).toMatchObject({
    actor: adminId,
    payload: { step: 'manager', holder: manager.id, reason: `${manager.id} was deprovisioned` },
  })
  const record = log.find((event) => event.type === 'user.deprovisioned@1')
  expect(record).toMatchObject({
    actor: adminId,
    payload: {
      principal: manager.id,
      released: [{ instanceId: instances.managed, step: 'manager' }],
    },
  })
  const timeline = await json<readonly { type: string; reason?: string }[]>(
    await personFetch(owner.token, `/api/v1/instances/${instances.managed}/timeline`),
    'reading the timeline'
  )
  expect(timeline.find((entry) => entry.type === 'task.released@1')?.reason).toBe(
    `${manager.id} was deprovisioned`
  )

  // The account signs in no more (ID-6).
  await expect(passwordToken(config, manager.email, manager.password)).rejects.toThrow()

  // The CLI runs the same deprovision through the public API; a second one
  // changes nothing and says so (I1).
  const signedIn = enform('admin', [
    'login',
    '--username',
    ADMIN_EMAIL,
    '--password',
    ADMIN_PASSWORD,
  ])
  expect(signedIn.status, signedIn.stderr).toBe(0)
  const again = enform('admin', ['admin', 'deprovision', manager.id])
  expect(again.status, again.stderr).toBe(0)
  expect(JSON.parse(again.stdout)).toMatchObject({
    ok: true,
    principal: manager.id,
    released: [],
    alreadyDeprovisioned: true,
  })
})

test('#267 S08 I10 a later submit that names the deprovisioned manager routes to Unroutable and alerts the owner', async () => {
  const { owner, databaseUrl } = requireSetup()
  await startAndSubmit(MANAGER_SLUG, instances.unroutable)
  expect(taskQueue(instances.unroutable), 'the task records the Unroutable queue').toBe(
    'queue:unroutable'
  )
  const queue = await json<readonly { instanceId: string }[]>(
    await personFetch(owner.token, '/api/v1/unroutable'),
    'reading the Unroutable queue as the owner'
  )
  expect(queue.map((item) => item.instanceId)).toContain(instances.unroutable)
  // The alert to the owner is in the outbox (I10, SE-2); the worker delivers it.
  const alerts = queryDatabase(
    databaseUrl,
    `select payload->>'to' from outbox where effect = 'send-unroutable' and instance_id = '${instances.unroutable}'`
  )
  expect(alerts).toContain(owner.id)
})

test('#267 ID-5 the scheduled synchronization deprovisions a user the directory disabled and provisions them once enabled again', async () => {
  const { leaver, owner } = requireSetup()
  await startAndSubmit(LEAVER_SLUG, instances.left)
  await claim(leaver.token, leaver.id, instances.left)
  expect((await readInstance(owner.token, instances.left)).status.holder).toBe(leaver.id)

  // The directory disables the account: the worker's next pass finds it and
  // deprovisions it as the directory (ID-5, I14).
  await setEnabled(leaver.id, false)
  const worker = startWorker()
  try {
    const record = await waitFor('the deprovision of the leaver', async () => {
      const log = await wholeLog()
      return log.find(
        (event) => event.type === 'user.deprovisioned@1' && event.payload.principal === leaver.id
      )
    })
    expect(record.actor).toBe('system:directory')
    expect(record.payload.released).toEqual([{ instanceId: instances.left, step: 'review' }])
  } finally {
    await worker.stop()
  }
  expect((await readInstance(owner.token, instances.left)).status.holder).toBeUndefined()

  // Enabled again, one pass of `enform admin sync` provisions the person (ID-5).
  await setEnabled(leaver.id, true)
  const synced = enformLocal(['admin', 'sync'])
  expect(synced.status, synced.stderr).toBe(0)
  expect(JSON.parse(synced.stdout)).toMatchObject({ ok: true, provisioned: [leaver.id] })
  const log = await wholeLog()
  expect(
    log.find(
      (event) => event.type === 'user.provisioned@1' && event.payload.principal === leaver.id
    )
  ).toMatchObject({ actor: 'system:directory' })
  // The task stays in the pool; the person claims it again (AS-4).
  const back = await passwordToken(requireSetup().config, leaver.email, leaver.password)
  await claim(back, leaver.id, instances.left)
  expect((await readInstance(owner.token, instances.left)).status.holder).toBe(leaver.id)
}, 150_000)
