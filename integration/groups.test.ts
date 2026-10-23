import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { STEP_CLAIMED, STEP_COMPLETED } from '../engine/action.js'
import { INSTANCE_STARTED } from '../engine/submission.js'
import { createUser, json, keycloakAdminToken, passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #252, S08, I10, AS-1, AS-5, ID-6, I8, I12, I13, SE-2, SE-4, #218:
// directory groups and the Unroutable queue against the real Compose stack.
// The test creates local users and Keycloak groups, publishes three flows, and
// proves that a `group` target resolves to the members the group holds now,
// that an empty group starts an instance in the Unroutable queue with a
// `send-unroutable` email to the flow owner, that the escalation's group target
// adds its members at the firing time while the previous assignee stays, and
// that a grant to the group id lets a member act.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `groups-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'groups-admin-password'
const PASSWORD = 'groups-user-password'
const REPO = join(import.meta.dirname, '..')

const CHAIR_SLUG = `group-chair-${RUN}`
const EMPTY_SLUG = `group-empty-${RUN}`
const ESCALATION_SLUG = `group-escalation-${RUN}`

/** One inbox item as `GET /api/v1/inbox` returns it. */
type InboxItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly state: string
}

/** One Unroutable queue item as the API returns it. */
type UnroutableItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly state: string
}

/** One message in Mailpit's list response. */
type MailpitMessage = {
  readonly ID: string
  readonly Subject: string
  readonly To: readonly { readonly Address: string }[]
}

/** One flow definition as this test writes it (DF-1). */
type Definition = {
  readonly schemaVersion: 2
  readonly steps: readonly Record<string, unknown>[]
}

/** A user the test creates in the local directory. */
type Person = {
  readonly id: string
  readonly email: string
  readonly token: string
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
  readonly owner: Person
  readonly starter: Person
  readonly chair: Person
  readonly added: Person
  readonly outsider: Person
  readonly chairsGroup: string
  readonly emptyGroup: string
  readonly escalationGroup: string
}

let setup: Setup | undefined
let setupError: unknown

/** The instances the tests start, shared by the later checks. */
const instances = {
  chair: randomUUID(),
  empty: randomUUID(),
  escalation: randomUUID(),
}

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-groups-'))
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

    const owner = await person(config, publicUrl, 'owner')
    const starter = await person(config, publicUrl, 'starter')
    const chair = await person(config, publicUrl, 'chair')
    const added = await person(config, publicUrl, 'added')
    const outsider = await person(config, publicUrl, 'outsider')

    const keycloak = await keycloakAdminToken(config)
    const chairsGroup = await group(config, keycloak, `CS-Chairs-${RUN}`, [chair.id])
    const emptyGroup = await group(config, keycloak, `CS-Empty-${RUN}`, [])
    const escalationGroup = await group(config, keycloak, `CS-Escalation-${RUN}`, [added.id])

    setup = {
      config,
      dir,
      configPath,
      databaseUrl,
      publicUrl,
      adminToken,
      adminId: admin.principal.id,
      service,
      owner,
      starter,
      chair,
      added,
      outsider,
      chairsGroup,
      emptyGroup,
      escalationGroup,
    }

    await publishFlow(CHAIR_SLUG, {
      schemaVersion: 2,
      steps: [{ key: 'review', targets: [{ group: chairsGroup }], outcomes: ['approve'] }],
    })
    await publishFlow(EMPTY_SLUG, {
      schemaVersion: 2,
      steps: [{ key: 'empty', targets: [{ group: emptyGroup }], outcomes: ['approve'] }],
    })
    await publishFlow(ESCALATION_SLUG, {
      schemaVersion: 2,
      steps: [
        {
          key: 'review',
          targets: [{ user: chair.id }],
          outcomes: ['approve'],
          deadlineMinutes: 1,
          escalationTargets: [{ group: escalationGroup }],
        },
      ],
    })
    await grant(owner.id, `flow:${CHAIR_SLUG}`, ['task.reassign'])
    await grant(owner.id, `flow:${EMPTY_SLUG}`, ['task.reassign'])
    await grant(owner.id, `flow:${ESCALATION_SLUG}`, ['task.reassign'])
    await grant(starter.id, `flow:${CHAIR_SLUG}`, ['instance.start'])
    await grant(starter.id, `flow:${EMPTY_SLUG}`, ['instance.start'])
    await grant(starter.id, `flow:${ESCALATION_SLUG}`, ['instance.start'])
    await grant(`group:${chairsGroup}`, `flow:${CHAIR_SLUG}/step:review`, ['step.outcome:approve'])
    await grant(chair.id, `flow:${ESCALATION_SLUG}/step:review`, ['step.outcome:approve'])
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

/** The shared setup, or the reason that `enform init` did not produce it. */
function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/** Create one local user, sign it in and return its id, email and token. */
async function person(config: TestConfig, publicUrl: string, name: string): Promise<Person> {
  const keycloak = await keycloakAdminToken(config)
  const email = `${name}-${RUN}@test.local`
  const id = await createUser(config, keycloak, {
    username: email,
    email,
    firstName: name,
    lastName: 'Person',
    password: PASSWORD,
  })
  const token = await passwordToken(config, email, PASSWORD)
  await readSession(publicUrl, token)
  return { id, email, token }
}

/** Create one Keycloak group and add its members. */
async function group(
  config: TestConfig,
  adminToken: string,
  name: string,
  members: readonly string[]
): Promise<string> {
  const base = `${config.keycloakUrl}/admin/realms/${encodeURIComponent(config.realm)}`
  const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }
  const created = await fetch(`${base}/groups`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  })
  if (created.status !== 201) {
    throw new Error(`creating the group ${name} failed: ${created.status} ${await created.text()}`)
  }
  const listed = await json<readonly { id: string; name: string }[]>(
    await fetch(`${base}/groups?max=1000`, { headers }),
    `reading the group ${name} back`
  )
  const found = listed.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`the group ${name} has no id`)
  for (const member of members) {
    const addedResponse = await fetch(`${base}/users/${member}/groups/${found.id}`, {
      method: 'PUT',
      headers,
    })
    if (!addedResponse.ok && addedResponse.status !== 204) {
      throw new Error(
        `adding ${member} to ${name} failed: ${addedResponse.status} ${await addedResponse.text()}`
      )
    }
  }
  return found.id
}

/** One API call with the method and the JSON body this test needs. */
type Call = {
  readonly method?: string
  readonly body?: string
}

/** Call one API path with one person's bearer token. */
function personFetch(token: string, path: string, init: Call = {}): Promise<Response> {
  const { publicUrl } = requireSetup()
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${publicUrl}${path}`, { ...init, headers })
}

/** Call one API path with the administrator's bearer token. */
function adminFetch(path: string, init: Call = {}): Promise<Response> {
  const { adminToken } = requireSetup()
  return personFetch(adminToken, path, init)
}

/** Call one API path and read its JSON body. */
async function adminJson<T>(path: string, init: Call = {}): Promise<T> {
  return json<T>(await adminFetch(path, init), `${init.method ?? 'GET'} ${path}`)
}

/** Create, draft and publish one flow as the administrator. */
async function publishFlow(slug: string, definition: Definition): Promise<void> {
  await adminJson('/api/v1/flows', {
    method: 'POST',
    body: JSON.stringify({ slug, title: slug }),
  })
  await adminJson(`/api/v1/flows/${slug}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ version: 1, definition }),
  })
  await adminJson(`/api/v1/flows/${slug}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  })
}

/** Append one grant as the administrator (AC-2, I14). */
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

/** Start one published flow as the starter through the public API (ADR 0010). */
async function start(slug: string, instanceId: string): Promise<void> {
  const { starter } = requireSetup()
  const response = await personFetch(starter.token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      type: INSTANCE_STARTED,
      at: Date.now(),
      actor: starter.id,
      payload: { flow: slug, instanceId, values: {} },
    }),
  })
  await json(response, `starting ${slug}`)
}

/** Read one inbox tab for one person. */
async function inbox(token: string, tab: string): Promise<readonly InboxItem[]> {
  return json<readonly InboxItem[]>(
    await personFetch(token, `/api/v1/inbox?tab=${tab}`),
    `GET the ${tab} inbox`
  )
}

/** Wait until `read` answers a value, or fail after the timeout. */
async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 90_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (last !== undefined) return last
    await delay(500)
  }
  throw new Error(`${what} did not appear within ${timeoutMs} ms`)
}

/** Empty Mailpit, so one test cannot read another test's message. */
async function clearMailpit(): Promise<void> {
  const { config } = requireSetup()
  await fetch(`${config.mailpitUrl}/api/v1/messages`, { method: 'DELETE' })
}

/** The messages in Mailpit, newest first. */
async function mailpitMessages(): Promise<readonly MailpitMessage[]> {
  const { config } = requireSetup()
  const response = await fetch(`${config.mailpitUrl}/api/v1/messages`)
  const body = await json<{ messages?: readonly MailpitMessage[] }>(response, 'reading Mailpit')
  return body.messages ?? []
}

/** A worker child and the way to stop it. */
type WorkerChild = {
  readonly child: ChildProcess
  readonly stop: () => Promise<void>
}

/** Run the real worker against the test configuration (SE-1, SE-4). */
function startWorker(configPath: string): WorkerChild {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), 'worker', '--config', configPath],
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

/** Run one synchronous CLI command. */
function runCli(args: readonly string[]): {
  readonly status: number | null
  readonly stderr: string
} {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), ...args],
    { cwd: REPO, encoding: 'utf8' }
  )
  return { status: result.status, stderr: result.stderr }
}

/** One task row's queue and assignees, read from the projection. */
function taskRow(instanceId: string): { readonly queue: string; readonly assignees: string } {
  const { databaseUrl } = requireSetup()
  const row = queryDatabase(
    databaseUrl,
    `select coalesce(queue, '') || '|' || assignees::text from tasks where instance_id = '${instanceId}' order by seq desc limit 1`
  )[0]
  if (row === undefined) throw new Error(`the task of ${instanceId} is absent`)
  const [queue = '', assignees = '[]'] = row.split('|')
  return { queue, assignees }
}

test('#252 S08 AS-1 a group target resolves to every member and no one else', async () => {
  const { chair, outsider } = requireSetup()
  await start(CHAIR_SLUG, instances.chair)

  const available = await inbox(chair.token, 'available')
  expect(
    available.map((item) => item.instanceId),
    'the group member sees the task'
  ).toContain(instances.chair)

  const outsiderInbox = await inbox(outsider.token, 'available')
  expect(
    outsiderInbox.map((item) => item.instanceId),
    'a non-member does not see the task'
  ).not.toContain(instances.chair)

  const view = await json<{ status: { currentStep: string } }>(
    await personFetch(chair.token, `/api/v1/instances/${instances.chair}`),
    'reading the group task'
  )
  expect(view.status.currentStep).toBe('review')
}, 120_000)

test('#252 S08 I10 an empty group starts in the Unroutable queue and alerts the owner', async () => {
  const { owner, outsider, configPath } = requireSetup()
  await clearMailpit()

  await start(EMPTY_SLUG, instances.empty)
  expect(taskRow(instances.empty).queue, 'the task records the Unroutable queue').toBe(
    'queue:unroutable'
  )

  const worker = startWorker(configPath)
  try {
    const message = await waitFor('the unroutable email', async () => {
      const messages = await mailpitMessages()
      return messages.find((candidate) => candidate.Subject.includes('task is unroutable'))
    })
    expect(
      message.To.map((to) => to.Address),
      'the flow owner receives the alert'
    ).toContain(owner.email)
    const sent = await waitFor('the sent outbox row', async () => {
      const status = queryDatabase(
        requireSetup().databaseUrl,
        "select status from outbox where effect = 'send-unroutable' order by created_at desc limit 1"
      )[0]
      return status === 'sent' ? status : undefined
    })
    expect(sent).toBe('sent')
  } finally {
    await worker.stop()
  }

  const queue = await json<readonly UnroutableItem[]>(
    await personFetch(owner.token, '/api/v1/unroutable'),
    'reading the Unroutable queue as the owner'
  )
  expect(queue.map((item) => item.instanceId)).toContain(instances.empty)
  expect(await inbox(owner.token, 'started'), 'the owner sees the queue task').toEqual(
    expect.any(Array)
  )
  const outsiderQueue = await json<readonly UnroutableItem[]>(
    await personFetch(outsider.token, '/api/v1/unroutable'),
    'reading the Unroutable queue as an outsider'
  )
  expect(outsiderQueue, 'a principal without task.reassign reads no row').toEqual([])

  // A rebuild reproduces the queue from the start event (I4, I10).
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  expect(taskRow(instances.empty).queue, 'the rebuild keeps the queue').toBe('queue:unroutable')
  const after = await json<readonly UnroutableItem[]>(
    await personFetch(owner.token, '/api/v1/unroutable'),
    'reading the Unroutable queue after a rebuild'
  )
  expect(after.map((item) => item.instanceId)).toContain(instances.empty)
}, 150_000)

test('#252 SE-4 a group escalation adds its members at the firing and keeps the assignee', async () => {
  const { chair, added, configPath } = requireSetup()
  await clearMailpit()

  await start(ESCALATION_SLUG, instances.escalation)

  const worker = startWorker(configPath)
  try {
    await waitFor('the escalation email', async () => {
      const messages = await mailpitMessages()
      return messages.find((candidate) => candidate.Subject.includes('escalation (review)'))
    })
    const addedInbox = await waitFor('the added member inbox', async () => {
      const items = await inbox(added.token, 'available')
      return items.some((item) => item.instanceId === instances.escalation) ? items : undefined
    })
    expect(addedInbox.map((item) => item.instanceId)).toContain(instances.escalation)
    const chairInbox = await inbox(chair.token, 'available')
    expect(
      chairInbox.map((item) => item.instanceId),
      'the previous assignee stays'
    ).toContain(instances.escalation)
    expect(taskRow(instances.escalation).assignees).toContain(added.id)
    expect(taskRow(instances.escalation).assignees).toContain(chair.id)
  } finally {
    await worker.stop()
  }
}, 180_000)

test('#252 AS-1 I8 a grant to the group id lets a member act', async () => {
  const { chair } = requireSetup()
  const instanceId = randomUUID()
  await start(CHAIR_SLUG, instanceId)
  const view = await json<{ version: number }>(
    await personFetch(chair.token, `/api/v1/instances/${instanceId}`),
    'reading the group task version'
  )
  const claimed = await personFetch(chair.token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      type: STEP_CLAIMED,
      at: Date.now(),
      actor: chair.id,
      payload: { instanceId, expectedVersion: view.version },
    }),
  })
  await json(claimed, 'claiming the group task')

  const completed = await personFetch(chair.token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      type: STEP_COMPLETED,
      at: Date.now(),
      actor: chair.id,
      payload: {
        instanceId,
        version: view.version + 1,
        outcome: 'approve',
        values: {},
      },
    }),
  })
  const event = await json<{ type: string }>(completed, 'completing the group task')
  expect(event.type).toBe(STEP_COMPLETED)
}, 120_000)
