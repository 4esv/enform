import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Grant } from '../engine/authorize.js'
import type { FlowDefinition } from '../engine/definition.js'
import { createUser, json, keycloakAdminToken, passwordToken, readSession } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #232, ID-6, DE-1, DX-1, DX-4, AC-1, AC-2, AC-4, AS-1, I8, ADR 0012:
// a real three-person journey against the production server on PostgreSQL and
// Keycloak. The administrator builds and publishes a two-step flow and grants
// the requester `instance.start` and the first step's outcome and the approver
// the approval outcome. The requester then signs in with a direct-grant token
// and starts and submits the flow without any flow read, edit or build scope
// and without `instance.read`; the approver claims and approves it. The
// administrator reads the flow's grants, and a principal outside the journey
// reads neither the grants nor the instance.

const RUN = randomUUID().slice(0, 8)
const SLUG = `starters-${RUN}`
const ADMIN_EMAIL = `starters-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'starters-admin-password'
const REQUESTER_PASSWORD = 'starters-requester-password'
const APPROVER_PASSWORD = 'starters-approver-password'
const OUTSIDER_PASSWORD = 'starters-outsider-password'
const INSTANCE_ID = randomUUID()

/** One event as the HTTP API returns it (api/openapi.yaml). */
type Event = {
  readonly seq: number
  readonly operationId: string
  readonly type: string
  readonly at: number
  readonly actor?: string
  readonly payload: Record<string, unknown>
}

/** The instance view that a start and each step read (#76). */
type InstanceView = {
  readonly instanceId: string
  readonly version: number
  readonly status: {
    readonly step: number
    readonly totalSteps: number
    readonly currentStep?: string
    readonly holder?: string
    readonly state: string
  }
  readonly values: Record<string, unknown>
}

/** One inbox item as the API returns it (VT-1). */
type InboxItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly state: string
}

type Person = {
  readonly id: string
  readonly token: string
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly publicUrl: string
  readonly adminToken: string
  readonly adminId: string
  readonly requester: Person
  readonly approver: Person
  readonly outsider: Person
  readonly service: EnformProcess
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-starters-'))
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
    const adminSession = await readSession(publicUrl, adminToken)
    const directoryToken = await keycloakAdminToken(config)
    const requester = await createPerson(
      config,
      publicUrl,
      directoryToken,
      `requester-${RUN}`,
      'Requester',
      REQUESTER_PASSWORD
    )
    const approver = await createPerson(
      config,
      publicUrl,
      directoryToken,
      `approver-${RUN}`,
      'Approver',
      APPROVER_PASSWORD
    )
    const outsider = await createPerson(
      config,
      publicUrl,
      directoryToken,
      `outsider-${RUN}`,
      'Outsider',
      OUTSIDER_PASSWORD
    )
    setup = {
      config,
      dir,
      publicUrl,
      adminToken,
      adminId: adminSession.principal.id,
      requester,
      approver,
      outsider,
      service,
    }
  } catch (error) {
    setupError = error
  }
}, 120_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

/** Create one directory user, sign in with a direct grant and read its principal. */
async function createPerson(
  config: TestConfig,
  publicUrl: string,
  directoryToken: string,
  username: string,
  displayName: string,
  password: string
): Promise<Person> {
  const created = await createUser(config, directoryToken, {
    username,
    email: `${username}@test.local`,
    firstName: displayName,
    lastName: 'User',
    password,
  })
  const token = await passwordToken(config, username, password)
  const session = await readSession(publicUrl, token)
  if (session.principal.id !== created) {
    throw new Error(`${username} signed in as ${session.principal.id}, not ${created}`)
  }
  return { id: created, token }
}

function requireSetup(): Setup {
  if (setup === undefined) {
    throw setupError ?? new Error('integration: the starters setup did not run')
  }
  return setup
}

/** The two-step definition: the starter fills `summary`, the approver approves. */
function twoStep(approverId: string): FlowDefinition {
  return {
    schemaVersion: 2,
    steps: [
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [{ key: 'summary', control: 'text', label: 'Summary' }],
        editable: ['summary'],
        outcomes: ['submit'],
      },
      {
        key: 'approve',
        targets: [{ user: approverId }],
        outcomes: ['approve'],
      },
    ],
  }
}

/** Call one path with a person's bearer token. */
async function fetchAs(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${requireSetup().publicUrl}${path}`, { ...init, headers })
}

/** Call one path and read its JSON body, or name the request that failed. */
async function jsonAs<T>(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<T> {
  return json<T>(await fetchAs(token, path, init), `${init.method ?? 'GET'} ${path}`)
}

/** Post one operation with a person's credential and answer the event. */
async function postOperation(
  token: string,
  actor: string,
  body: Record<string, unknown>
): Promise<Event> {
  return jsonAs<Event>(token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), at: Date.now(), actor, ...body }),
  })
}

/** Read one inbox tab as a person (VT-1). */
async function inbox(token: string, tab: 'my' | 'available' | 'started') {
  return jsonAs<readonly InboxItem[]>(token, `/api/v1/inbox?tab=${tab}`)
}

test('#232 the administrator publishes the flow and grants the requester and the approver', async () => {
  const { approver, adminId, requester } = requireSetup()
  const definition = twoStep(approver.id)

  await jsonAs<{ slug: string; version: number }>(requireSetup().adminToken, '/api/v1/flows', {
    method: 'POST',
    body: JSON.stringify({ slug: SLUG, title: 'Starters' }),
  })
  const written = await jsonAs<{ slug: string; version: number; definition: FlowDefinition }>(
    requireSetup().adminToken,
    `/api/v1/flows/${SLUG}/draft`,
    { method: 'PUT', body: JSON.stringify({ version: 1, definition }) }
  )
  expect(written.definition).toEqual(definition)
  const published = await jsonAs<{ slug: string; version: number }>(
    requireSetup().adminToken,
    `/api/v1/flows/${SLUG}/publish`,
    { method: 'POST', body: JSON.stringify({ version: 1 }) }
  )
  expect(published.version).toBe(1)

  const grants: readonly Grant[] = [
    { principal: requester.id, scopes: ['instance.start'], resource: `flow:${SLUG}` },
    {
      principal: requester.id,
      scopes: ['step.outcome:submit'],
      resource: `flow:${SLUG}/step:request`,
    },
    {
      principal: approver.id,
      scopes: ['step.outcome:approve'],
      resource: `flow:${SLUG}/step:approve`,
    },
  ]
  for (const grant of grants) {
    const event = await postOperation(requireSetup().adminToken, adminId, {
      type: 'config.grant.changed@1',
      payload: grant,
    })
    expect(event.type).toBe('config.grant.changed@1')
  }

  const read = await jsonAs<readonly Grant[]>(
    requireSetup().adminToken,
    `/api/v1/flows/${SLUG}/grants`
  )
  expect(read, 'the administrator reads the flow and step grants in log order').toEqual(grants)

  // The requester holds only the start and first-step outcome scopes. The
  // published read is open through `instance.start`, but the draft, the write
  // and the grant set are not (AC-1, I8).
  expect(
    read.filter((grant) => grant.principal === requester.id),
    'the requester holds exactly the start and submit scopes'
  ).toEqual([grants[0], grants[1]])
  for (const person of [requester, approver]) {
    const denied = await fetchAs(person.token, `/api/v1/flows/${SLUG}/grants`)
    expect(denied.status, `${person.id} may not read the grants`).toBe(403)
    const draft = await fetchAs(person.token, `/api/v1/flows/${SLUG}/draft`)
    expect(draft.status, `${person.id} may not read the draft`).toBe(403)
  }
  const requesterDraft = await fetchAs(requester.token, `/api/v1/flows/${SLUG}/draft`)
  expect(requesterDraft.status, 'the requester has no flow read, edit or build scope').toBe(403)
})

test('#232 the requester starts and submits without a flow scope and the approver approves', async () => {
  const { adminToken, approver, outsider, requester } = requireSetup()

  const started = await postOperation(requester.token, requester.id, {
    type: 'instance.started@1',
    payload: { flow: SLUG, instanceId: INSTANCE_ID, values: { summary: 'Please approve' } },
  })
  expect(started.actor, 'the requester is the actor').toBe(requester.id)
  expect(started.payload.currentStep).toBe('request')
  expect(started.payload.assignees).toEqual([
    { step: 'request', target: { starter: 'starter' }, members: [requester.id] },
  ])

  const first = await jsonAs<InstanceView>(requester.token, `/api/v1/instances/${INSTANCE_ID}`)
  expect(first.status, 'the start put the requester on step 1').toMatchObject({
    step: 1,
    totalSteps: 2,
    currentStep: 'request',
    state: 'waiting',
  })
  expect(first.values, 'the start records the requester value').toEqual({
    summary: 'Please approve',
  })

  await postOperation(requester.token, requester.id, {
    type: 'step.claimed@1',
    payload: { instanceId: INSTANCE_ID, expectedVersion: first.version },
  })
  const heldRequest = await jsonAs<InstanceView>(
    requester.token,
    `/api/v1/instances/${INSTANCE_ID}`
  )
  expect(heldRequest.status.holder, 'the requester holds the request').toBe(requester.id)

  await postOperation(requester.token, requester.id, {
    type: 'step.completed@1',
    payload: {
      instanceId: INSTANCE_ID,
      version: heldRequest.version,
      outcome: 'submit',
      values: { summary: 'Please approve' },
    },
  })
  const atApproval = await jsonAs<InstanceView>(requester.token, `/api/v1/instances/${INSTANCE_ID}`)
  expect(atApproval.status, 'the submitted request moved to the approval').toMatchObject({
    step: 2,
    totalSteps: 2,
    currentStep: 'approve',
    state: 'waiting',
  })

  const approval = await jsonAs<InstanceView>(approver.token, `/api/v1/instances/${INSTANCE_ID}`)
  expect(approval.status.currentStep, 'the approver reads the approval as an assignee').toBe(
    'approve'
  )
  await postOperation(approver.token, approver.id, {
    type: 'step.claimed@1',
    payload: { instanceId: INSTANCE_ID, expectedVersion: approval.version },
  })
  const heldApproval = await jsonAs<InstanceView>(
    approver.token,
    `/api/v1/instances/${INSTANCE_ID}`
  )
  expect(heldApproval.status.holder, 'the approver holds the approval').toBe(approver.id)

  await postOperation(approver.token, approver.id, {
    type: 'step.completed@1',
    payload: {
      instanceId: INSTANCE_ID,
      version: heldApproval.version,
      outcome: 'approve',
      values: {},
    },
  })

  const done = await jsonAs<InstanceView>(requester.token, `/api/v1/instances/${INSTANCE_ID}`)
  expect(done.status.state, 'the approved instance is done').toBe('done')
  expect(done.status.currentStep, 'a done instance has no current step').toBeUndefined()

  // The outsider is neither the starter nor an assignee and holds no
  // instance.read, so the grants, the instance and every inbox tab are closed
  // to it (I8, AC-5).
  const deniedInstance = await fetchAs(outsider.token, `/api/v1/instances/${INSTANCE_ID}`)
  expect(deniedInstance.status, await deniedInstance.text()).toBe(403)
  for (const tab of ['my', 'available', 'started'] as const) {
    const items = await inbox(outsider.token, tab)
    expect(
      items.some((item) => item.instanceId === INSTANCE_ID),
      `the outsider reads no ${tab} item`
    ).toBe(false)
  }

  // The administrator still reads the instance and its grants.
  const adminView = await jsonAs<InstanceView>(adminToken, `/api/v1/instances/${INSTANCE_ID}`)
  expect(adminView.status.state, 'the administrator reads the done instance').toBe('done')
  const grants = await jsonAs<readonly Grant[]>(adminToken, `/api/v1/flows/${SLUG}/grants`)
  expect(grants, 'the grant set is unchanged by the journey').toHaveLength(3)
})
