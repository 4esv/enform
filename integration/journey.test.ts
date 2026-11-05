import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Grant } from '../engine/authorize.js'
import type { FlowDefinition } from '../engine/definition.js'
import { addGrant } from '../engine/grants.js'
import type { Operation } from '../engine/operation.js'
import { appendOperation, createPool } from '../server/db.js'
import { newOperationId } from '../server/ids.js'
import { createUser, json, keycloakAdminToken, passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #222, #218, ID-6, DE-1, DX-1, WF-1, AS-2, AC-4, I1, I4, I5, I8, ADR
// 0012, ADR 0013: one instance runs through the real server on PostgreSQL and
// Keycloak. `enform init` writes the configuration, migrates the store and
// creates the first administrator; the test then uses HTTP only to create and
// publish a two-step flow, start an instance, read it, claim and complete the
// request, read the approval step, claim and complete it, read the done
// instance, prove that a stale completion and a stale claim answer 409 and
// append nothing, read the log and the state, rebuild the projections and
// prove that a second instance never appears in the first instance's read.
//
// The shape of a write is the intent of ADR 0010: the client names the flow,
// the instance and the values it collected for a start, and the instance, the
// version it read, the outcome and the values for a completion. A claim names
// the instance and the version it read. The session identifies the actor, so
// the bogus actor in each body is ignored.

const RUN = randomUUID().slice(0, 8)
const SLUG = `journey-${RUN}`
const ADMIN_EMAIL = `journey-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'journey-admin-password'
const REPO = join(import.meta.dirname, '..')
const INSTANCE_ID = randomUUID()
const SECOND_INSTANCE_ID = randomUUID()

/** One event as the HTTP API returns it (api/openapi.yaml). */
type Event = {
  readonly seq: number
  readonly operationId: string
  readonly type: string
  readonly at: number
  readonly actor?: string
  readonly payload: Record<string, unknown>
}

type StateView = {
  readonly applied: readonly string[]
  readonly log: readonly Event[]
}

type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: {
    readonly step: number
    readonly totalSteps: number
    readonly currentStep?: string
    readonly holder?: string
    readonly state: string
    readonly skipped: readonly unknown[]
  }
  readonly visible: readonly string[]
  readonly editable: readonly string[]
  readonly required: readonly string[]
  readonly collapsed: readonly string[]
  readonly values: Record<string, unknown>
}

type PublishedFlow = {
  readonly slug: string
  readonly version: number
  readonly contentHash: string
  readonly definition: FlowDefinition
}

/** One inbox item as the API returns it (VT-1, VT-2, S14). */
type InboxItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly state: string
  readonly holder?: string
  readonly dueAt?: number
  readonly lastActivityAt?: number
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
}

let setup: Setup | undefined
let setupError: unknown

/** The state that the journey accumulates between tests. */
type Journey = {
  requestStartId: string
  submitRequestId: string
  staleCompleteId: string
  claimApproveId: string
  staleClaimId: string
  completeApproveId: string
}

let journey: Journey | undefined

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-journey-'))
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

    const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
    const session = await readSession(publicUrl, adminToken)
    setup = {
      config,
      dir,
      configPath,
      databaseUrl,
      publicUrl,
      adminToken,
      adminId: session.principal.id,
      service,
    }
    journey = {
      requestStartId: '',
      submitRequestId: '',
      staleCompleteId: '',
      claimApproveId: '',
      staleClaimId: '',
      completeApproveId: '',
    }
  } catch (error) {
    setupError = error
  }
}, 120_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

/** The shared setup, or the reason that `enform init` did not produce it. */
function requireSetup(): Setup {
  if (setup === undefined) {
    throw setupError ?? new Error('integration: the shared setup did not run')
  }
  return setup
}

/** The journey state, or the reason that the setup did not produce it. */
function requireJourney(): Journey {
  if (journey === undefined) throw setupError ?? new Error('integration: the journey did not start')
  return journey
}

/** The two-step definition: the starter fills `summary`, the administrator approves it. */
function twoStep(adminId: string): FlowDefinition {
  return {
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [{ key: 'summary', control: 'text' }],
        editable: ['summary'],
      },
      {
        key: 'approve',
        targets: [{ user: adminId }],
        outcomes: ['approve'],
      },
    ],
  }
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

/** Post one operation and answer the event the log holds. */
async function postOperation(body: Record<string, unknown>): Promise<Event> {
  return adminJson<Event>('/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Read one inbox tab as the administrator (VT-1). */
async function inbox(tab: 'my' | 'available' | 'started'): Promise<readonly InboxItem[]> {
  return adminJson<readonly InboxItem[]>(`/api/v1/inbox?tab=${tab}`)
}

/** The number of events the log holds, read from PostgreSQL. */
function eventCount(): number {
  const { databaseUrl } = requireSetup()
  return Number(queryDatabase(databaseUrl, 'select count(*) from events')[0])
}

/**
 * Append the outcome grant of the journey. This lane has no grant
 * configuration endpoint (issue #222), so the fixture appends them the way
 * `enform init` appends the administrator's grants: through the engine's
 * `addGrant` and the store's `appendOperation`. The journey itself is HTTP
 * only.
 */
async function grantOutcomes(flow: string, principal: string, outcomes: readonly string[]) {
  const { databaseUrl } = requireSetup()
  const pool = createPool(databaseUrl)
  try {
    for (const outcome of outcomes) {
      const grant: Grant = {
        principal,
        scopes: [`step.outcome:${outcome}`],
        resource: `flow:${flow}`,
      }
      const operation: Operation = addGrant(grant, principal, {
        clock: () => Date.now(),
        ids: () => newOperationId(),
      })
      await appendOperation(pool, operation)
    }
  } finally {
    await pool.end()
  }
}

test('#222 WF-1 an administrator creates and publishes a two-step flow', async () => {
  const { adminId } = requireSetup()
  const created = await adminJson<{ slug: string; version: number; definition: FlowDefinition }>(
    '/api/v1/flows',
    { method: 'POST', body: JSON.stringify({ slug: SLUG, title: 'Journey' }) }
  )
  expect(created.slug).toBe(SLUG)

  const definition = twoStep(adminId)
  const written = await adminJson<{ slug: string; version: number; definition: FlowDefinition }>(
    `/api/v1/flows/${SLUG}/draft`,
    { method: 'PUT', body: JSON.stringify({ version: 1, definition }) }
  )
  expect(written.definition).toEqual(definition)

  const published = await adminJson<PublishedFlow>(`/api/v1/flows/${SLUG}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  })
  expect(published.version, 'the first publication is version 1').toBe(1)
  expect(published.definition).toEqual(definition)

  await grantOutcomes(SLUG, adminId, ['approve'])
})

test('#222 DX-1 I8 a start intent records the session principal, the flow and the route', async () => {
  const { adminId } = requireSetup()
  const ids = requireJourney()
  ids.requestStartId = randomUUID()
  const event = await postOperation({
    id: ids.requestStartId,
    type: 'instance.started@1',
    at: Date.now(),
    // The session identifies the actor; this value must not reach the log.
    actor: 'user:someone-else',
    payload: { flow: SLUG, instanceId: INSTANCE_ID, values: { summary: 'hello' } },
  })

  expect(event.type).toBe('instance.started@1')
  expect(event.actor, 'the session principal is the actor').toBe(adminId)
  expect(event.payload.flow, 'the instance names its flow').toBe(SLUG)
  expect(event.payload.instanceId).toBe(INSTANCE_ID)
  expect(event.payload.currentStep).toBe('request')
  expect(event.payload.assignees).toEqual([
    { step: 'request', target: { starter: 'starter' }, members: [adminId] },
  ])

  expect(event.payload.skipped, 'a start routes nothing').toEqual([])

  // The start is a private draft (ADR 0014): `started` tracks it as a draft
  // for its starter, no task exists yet, so `available` and `my` stay empty
  // (VT-1, VT-2, VT-4).
  const started = await inbox('started')
  const startedItem = started.find((item) => item.instanceId === INSTANCE_ID)
  expect(startedItem, 'the started tab holds the new draft').toMatchObject({
    flowSlug: SLUG,
    step: 'request',
    state: 'draft',
  })
  expect(startedItem?.holder, 'nobody holds a draft').toBeUndefined()
  expect(startedItem?.dueAt, 'the step sets no deadline').toBeUndefined()
  expect(startedItem?.lastActivityAt, 'the start is the last activity').toBeGreaterThan(0)
  expect(
    (await inbox('available')).some((item) => item.instanceId === INSTANCE_ID),
    'a draft is not available to anybody'
  ).toBe(false)
  expect(
    (await inbox('my')).some((item) => item.instanceId === INSTANCE_ID),
    'my tasks is empty before a claim'
  ).toBe(false)
})

test('#222 FM-7 the instance read shows the request step, the values and the version', async () => {
  const { publicUrl, adminToken } = requireSetup()
  const response = await fetch(`${publicUrl}/api/v1/instances/${INSTANCE_ID}?actor=user:outsider`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  const view = await json<InstanceView>(response, 'GET /api/v1/instances as the starter')

  expect(response.status, 'the actor query parameter does not authorize').toBe(200)
  expect(view.instanceId).toBe(INSTANCE_ID)
  expect(view.version, 'the start is version 0').toBe(0)
  expect(view.status.currentStep).toBe('request')
  expect(view.status.state, 'the start is a draft').toBe('draft')
  expect(view.status.step).toBe(1)
  expect(view.status.totalSteps).toBe(2)
  expect(view.visible).toEqual(['summary'])
  expect(view.editable).toEqual(['summary'])
  expect(view.values).toEqual({ summary: 'hello' })
})

test('#222 ADR 0014 FM-4 the starter submits the draft and the approval becomes available', async () => {
  const { adminId } = requireSetup()
  const ids = requireJourney()

  // Nobody claims a draft, not even its starter (ADR 0014): the engine
  // refuses and appends nothing.
  const before = eventCount()
  const claimDraft = await adminFetch('/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      type: 'step.claimed@1',
      at: Date.now(),
      actor: 'user:someone-else',
      payload: { instanceId: INSTANCE_ID, expectedVersion: 0 },
    }),
  })
  const draftRefusal = (await claimDraft.json()) as { error: string }
  expect(claimDraft.status, draftRefusal.error).toBe(409)
  expect(draftRefusal.error).toMatch(/draft/)
  expect(eventCount(), 'a refused claim appends nothing').toBe(before)

  // The submit completes the request form with the values it captured and
  // routes the instance to the approval step (ADR 0014, FM-4, FM-7, WF-1).
  ids.submitRequestId = randomUUID()
  const submitted = await postOperation({
    id: ids.submitRequestId,
    type: 'instance.submitted@1',
    at: Date.now(),
    actor: 'user:someone-else',
    payload: { instanceId: INSTANCE_ID, version: 0, values: { summary: 'hello again' } },
  })
  expect(submitted.type).toBe('instance.submitted@1')
  expect(submitted.payload.step, 'the engine decided the step').toBe('request')
  expect(submitted.payload.currentStep, 'the engine decided the route').toBe('approve')
  expect(submitted.payload.values).toEqual({ summary: 'hello again' })
  expect(submitted.payload.assignees).toEqual([
    { step: 'approve', target: { user: adminId }, members: [adminId] },
  ])
  expect(submitted.actor).toBe(adminId)

  const afterSubmit = await adminJson<InstanceView>(`/api/v1/instances/${INSTANCE_ID}`)
  expect(afterSubmit.version, 'the submit advanced the version').toBe(1)
  expect(afterSubmit.status.currentStep).toBe('approve')
  expect(afterSubmit.status.state).toBe('waiting')
  // The approval step makes no field visible, so the read restricts the
  // values to none (FM-3); the submit event above recorded them (FM-7).
  expect(afterSubmit.values).toEqual({})

  // The request completed, so the approval step is the one in the inbox: it is
  // available to its assignee and not in my tasks (VT-1, VT-2).
  const available = await inbox('available')
  const approval = available.find((item) => item.instanceId === INSTANCE_ID)
  expect(approval, 'the approval step is available').toMatchObject({
    step: 'approve',
    state: 'unopened',
  })
  expect(approval?.holder).toBeUndefined()
  expect(
    (await inbox('my')).some((item) => item.instanceId === INSTANCE_ID),
    'nothing is held yet'
  ).toBe(false)

  // A second submit of a submitted instance is refused: it is no draft.
  const again = await adminFetch('/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: randomUUID(),
      type: 'instance.submitted@1',
      at: Date.now(),
      actor: 'user:someone-else',
      payload: { instanceId: INSTANCE_ID, version: 1, values: {} },
    }),
  })
  const againRefusal = (await again.json()) as { error: string }
  expect(again.status, againRefusal.error).toBe(409)
  expect(againRefusal.error).toMatch(/not a draft/)
})

test('#222 I5 a stale completion answers 409 and appends nothing', async () => {
  const ids = requireJourney()
  ids.staleCompleteId = randomUUID()
  const before = eventCount()
  const response = await adminFetch('/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: ids.staleCompleteId,
      type: 'step.completed@1',
      at: Date.now(),
      actor: 'user:someone-else',
      payload: {
        instanceId: INSTANCE_ID,
        // The submit advanced the instance to version 1; a view of version 0
        // is stale.
        version: 0,
        outcome: 'approve',
        values: {},
      },
    }),
  })
  const body = (await response.json()) as { error: string }
  expect(response.status, body.error).toBe(409)
  expect(body.error).toMatch(/stale/)
  expect(eventCount(), 'a refusal appends nothing').toBe(before)
})

test('#222 AS-2 I5 claim and complete the approval step', async () => {
  const { adminId } = requireSetup()
  const ids = requireJourney()
  ids.claimApproveId = randomUUID()
  const claimed = await postOperation({
    id: ids.claimApproveId,
    type: 'step.claimed@1',
    at: Date.now(),
    actor: 'user:someone-else',
    payload: { instanceId: INSTANCE_ID, expectedVersion: 1 },
  })
  expect(claimed.payload).toEqual({ instanceId: INSTANCE_ID, step: 'approve', holder: adminId })

  // A claimed approval moves from `available` to my tasks, with its holder
  // (VT-1, AS-2, VT-2).
  expect(
    (await inbox('my')).find((item) => item.instanceId === INSTANCE_ID),
    'the holder sees the approval in my tasks'
  ).toMatchObject({ step: 'approve', state: 'opened', holder: adminId })
  expect(
    (await inbox('available')).some((item) => item.instanceId === INSTANCE_ID),
    'a claimed approval is not available'
  ).toBe(false)

  // A second claim of the same task with the version it read before the first
  // claim is refused, so exactly one claim wins (AS-2, I5).
  ids.staleClaimId = randomUUID()
  const before = eventCount()
  const stale = await adminFetch('/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({
      id: ids.staleClaimId,
      type: 'step.claimed@1',
      at: Date.now(),
      actor: 'user:someone-else',
      payload: { instanceId: INSTANCE_ID, expectedVersion: 1 },
    }),
  })
  const refusal = (await stale.json()) as { error: string }
  expect(stale.status, refusal.error).toBe(409)
  expect(eventCount(), 'a refused claim appends nothing').toBe(before)

  ids.completeApproveId = randomUUID()
  const completed = await postOperation({
    id: ids.completeApproveId,
    type: 'step.completed@1',
    at: Date.now(),
    actor: 'user:someone-else',
    payload: {
      instanceId: INSTANCE_ID,
      version: 2,
      outcome: 'approve',
      values: {},
    },
  })
  expect(completed.payload.step).toBe('approve')
  expect(completed.payload.outcome).toBe('approve')
  expect(completed.payload.done, 'the last step completes the instance').toBe(true)

  const done = await adminJson<InstanceView>(`/api/v1/instances/${INSTANCE_ID}`)
  expect(done.version, 'the final completion advanced the version').toBe(3)
  expect(done.status.state, 'the last step completes the instance').toBe('done')
  expect(done.status.currentStep, 'a done instance has no current step').toBeUndefined()

  // A done instance is gone from every open tab (VT-1, VT-2).
  for (const tab of ['my', 'available', 'started'] as const) {
    expect(
      (await inbox(tab)).some((item) => item.instanceId === INSTANCE_ID),
      `the done instance is absent from ${tab}`
    ).toBe(false)
  }
})

test('#222 I4 the log and the state hold the journey in sequence order', async () => {
  const ids = requireJourney()
  const log = await adminJson<readonly Event[]>('/api/v1/log')
  const state = await adminJson<StateView>('/api/v1/state')

  const operationIds = [ids.requestStartId, ids.submitRequestId, ids.claimApproveId]
  let previous = 0
  for (const operationId of operationIds) {
    const event = log.find((entry) => entry.operationId === operationId)
    expect(event, `${operationId} is on the log`).toBeDefined()
    expect(event?.seq ?? 0, 'the log is in sequence order').toBeGreaterThan(previous)
    previous = event?.seq ?? 0
    expect(state.applied, 'the state names every applied operation').toContain(operationId)
  }
  expect(state.log.length, 'the state carries the whole log').toBe(log.length)
  expect(
    log.some((entry) => entry.operationId === ids.staleCompleteId),
    'a refused operation is not on the log'
  ).toBe(false)
})

test('#222 I4 a second instance never appears in the first instance read', async () => {
  const first = await adminJson<InstanceView>(`/api/v1/instances/${INSTANCE_ID}`)
  await postOperation({
    id: randomUUID(),
    type: 'instance.started@1',
    at: Date.now(),
    actor: 'user:someone-else',
    payload: {
      flow: SLUG,
      instanceId: SECOND_INSTANCE_ID,
      values: { summary: 'second' },
    },
  })

  expect(await adminJson<InstanceView>(`/api/v1/instances/${INSTANCE_ID}`)).toEqual(first)
  const second = await adminJson<InstanceView>(`/api/v1/instances/${SECOND_INSTANCE_ID}`)
  expect(second.instanceId).toBe(SECOND_INSTANCE_ID)
  expect(second.status.currentStep).toBe('request')
  expect(second.status.state, 'the second instance is a draft').toBe('draft')
  expect(second.values).toEqual({ summary: 'second' })

  // The second instance is the one the started tab now shows; the first is
  // done and absent (VT-1).
  const started = await inbox('started')
  const secondItem = started.find((item) => item.instanceId === SECOND_INSTANCE_ID)
  expect(secondItem, 'the second instance is in the started tab').toMatchObject({ state: 'draft' })
  expect(
    secondItem?.dueAt,
    'the request step sets no deadline, so it lends no timer'
  ).toBeUndefined()
  expect(started.some((item) => item.instanceId === INSTANCE_ID)).toBe(false)
})

test('#222 I4 enform admin rebuild reproduces the instance projections', async () => {
  const { configPath, databaseUrl } = requireSetup()
  const readBefore = await adminJson<InstanceView>(`/api/v1/instances/${INSTANCE_ID}`)
  const instancesBefore = queryDatabase(
    databaseUrl,
    `select id, flow_slug, current_step, submitted, done, version from instances where id = '${INSTANCE_ID}'`
  )
  const tasksBefore = queryDatabase(
    databaseUrl,
    `select instance_id, step, holder, state, last_activity_at from tasks where instance_id = '${INSTANCE_ID}' order by step`
  )
  expect(instancesBefore, 'the store projected the instance').toHaveLength(1)

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(REPO, 'cli', 'main.ts'),
      'admin',
      'rebuild',
      '--config',
      configPath,
    ],
    { cwd: REPO, encoding: 'utf8' }
  )
  expect(result.status, result.stderr).toBe(0)

  expect(
    queryDatabase(
      databaseUrl,
      `select id, flow_slug, current_step, submitted, done, version from instances where id = '${INSTANCE_ID}'`
    ),
    'the instance projection is unchanged'
  ).toEqual(instancesBefore)
  expect(
    queryDatabase(
      databaseUrl,
      `select instance_id, step, holder, state, last_activity_at from tasks where instance_id = '${INSTANCE_ID}' order by step`
    ),
    'the task projection is unchanged'
  ).toEqual(tasksBefore)
  expect(
    await adminJson<InstanceView>(`/api/v1/instances/${INSTANCE_ID}`),
    'the read is unchanged'
  ).toEqual(readBefore)
})

test('#222 I8 a principal that may not read the instance answers 403', async () => {
  const { config, publicUrl } = requireSetup()
  const adminToken = await keycloakAdminToken(config)
  const username = `journey-outsider-${RUN}`
  await createUser(config, adminToken, {
    username,
    email: `${username}@test.local`,
    firstName: 'Out',
    lastName: 'Sider',
    password: 'journey-outsider-password',
  })
  const token = await passwordToken(config, username, 'journey-outsider-password')
  const response = await fetch(`${publicUrl}/api/v1/instances/${INSTANCE_ID}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.status, await response.text()).toBe(403)

  // The inbox never shows another principal's task, even the instance the
  // administrator's started tab holds (I8, VT-1).
  for (const tab of ['my', 'available', 'started'] as const) {
    const inboxResponse = await fetch(`${publicUrl}/api/v1/inbox?tab=${tab}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(inboxResponse.status, `GET /api/v1/inbox?tab=${tab}`).toBe(200)
    expect(await inboxResponse.json(), `the outsider reads no ${tab} item`).toEqual([])
  }
})
