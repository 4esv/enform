import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// Issue #234, DE-4, ID-6, DF-1, DF-2, WF-1, AS-1, AS-6, AC-1, AC-2, AC-4, I4,
// I14: the demo seed against the real Compose stack. `enform init` writes the
// configuration, migrates the store and serves the configured URL. The test
// then loads `enform seed demo`, signs in as two of the demo users, reads the
// flow and the in-flight instances through the API, clears the profile, and
// proves that a rebuild never resurrects it while the real administrator and a
// real flow survive.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `seed-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'seed-admin-password'
const REAL_SLUG = `real-${RUN}`
const REPO = join(import.meta.dirname, '..')
const DEMO_PROFILE = 'demo'

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

/** The JSON body of `seed demo` or `seed clear`. */
type SeedOutput = {
  readonly ok: boolean
  readonly profile: string
  readonly alreadySeeded?: boolean
  readonly run?: string
  readonly flow?: { readonly slug: string; readonly title: string; readonly url: string }
  readonly users?: readonly DemoUser[]
  readonly teams?: readonly { readonly name: string; readonly members: readonly string[] }[]
  readonly groups?: readonly {
    readonly id: string
    readonly name: string
    readonly members: readonly string[]
  }[]
  readonly instances?: readonly DemoInstance[]
  readonly records?: number
  readonly cleared?: {
    readonly users: readonly { readonly id: string }[]
    readonly teams: readonly { readonly id: string }[]
    readonly groups: readonly { readonly id: string }[]
    readonly flows: readonly { readonly id: string }[]
    readonly instances: readonly { readonly id: string }[]
    readonly grants: readonly { readonly id: string }[]
  }
  readonly operationId?: string
}

/** One flow summary as `GET /api/v1/flows` returns it. */
type FlowSummary = {
  readonly slug: string
  readonly draftVersion: number
}

/** One inbox item as `GET /api/v1/inbox` returns it. */
type InboxItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly state: string
}

/** One event as `GET /api/v1/log` returns it. */
type Event = {
  readonly type: string
  readonly actor?: string
  readonly payload: Record<string, unknown>
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

type SeedState = {
  seed: SeedOutput
  samToken: string
  okaforToken: string
}

let setup: Setup | undefined
let setupError: unknown
let seedState: SeedState | undefined

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-seed-'))
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
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/** The seed state, or the reason that the seed test did not produce it. */
function requireSeedState(): SeedState {
  if (seedState === undefined) {
    throw setupError ?? new Error('integration: the seed did not run')
  }
  return seedState
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

/** Call one API path with a demo user's bearer token. */
async function userFetch(token: string, path: string): Promise<Response> {
  const { publicUrl } = requireSetup()
  return fetch(`${publicUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })
}

/** Read one inbox tab as the administrator. */
async function adminInbox(tab: 'my' | 'available' | 'started'): Promise<readonly InboxItem[]> {
  return adminJson<readonly InboxItem[]>(`/api/v1/inbox?tab=${tab}`)
}

/** The count of one seed record kind that the database still holds, live or cleared. */
function seedRecordCount(liveOnly: boolean): number {
  const { databaseUrl } = requireSetup()
  const live = liveOnly ? 'and cleared_at is null' : ''
  return Number(
    queryDatabase(
      databaseUrl,
      `select count(*) from seed_records where profile = '${DEMO_PROFILE}' ${live}`
    )[0]
  )
}

test('#234 DE-4 seed demo loads the cast, the grants, the flow and four instances', async () => {
  const { config, configPath, databaseUrl } = requireSetup()
  const result = runCli(['seed', 'demo', '--config', configPath, '--json'])
  expect(result.status, result.stderr).toBe(0)
  const seed = JSON.parse(result.stdout) as SeedOutput

  expect(seed.ok).toBe(true)
  expect(seed.profile).toBe(DEMO_PROFILE)
  expect(seed.alreadySeeded).toBe(false)
  expect(seed.users, 'the six story people are created').toHaveLength(6)
  expect(seed.users?.map((user) => user.role).sort()).toEqual([
    'advisor',
    'chair',
    'reader',
    'registrar',
    'registrar',
    'starter',
  ])
  for (const user of seed.users ?? []) {
    expect(user.email, 'a demo email').toMatch(/@demo\.local$/)
    expect(user.password.length, 'a generated password').toBeGreaterThan(10)
    expect(user.id, 'the immutable Keycloak id').not.toBe('')
  }
  expect(seed.teams?.map((team) => team.name).sort()).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^chairs-/),
      expect.stringMatching(/^registrar-office-/),
    ])
  )
  expect(seed.flow?.slug, 'the flow slug carries the run suffix').toMatch(/^demo-course-overload-/)
  expect(seed.flow?.url).toBe(
    `${requireSetup().publicUrl}/?flow=${encodeURIComponent(seed.flow?.slug ?? '')}`
  )
  expect(seed.instances, 'four in-flight instances').toHaveLength(4)
  expect(
    seed.instances?.map((instance) => (instance.done ? 'done' : instance.step)).sort()
  ).toEqual(['advisor', 'done', 'registrar', 'request'])
  expect(seed.records, 'every record is marked').toBeGreaterThan(13)
  expect(seedRecordCount(true), 'the live seed records are stored').toBe(seed.records)

  const sam = seed.users?.find((user) => user.role === 'starter')
  const okafor = seed.users?.find((user) => user.role === 'advisor')
  if (sam === undefined || okafor === undefined) throw new Error('the demo cast is incomplete')
  const samToken = await passwordToken(config, sam.email, sam.password)
  const okaforToken = await passwordToken(config, okafor.email, okafor.password)
  seedState = { seed, samToken, okaforToken }

  const eventsBefore = Number(queryDatabase(databaseUrl, 'select count(*) from events')[0])
  const second = runCli(['seed', 'demo', '--config', configPath, '--json'])
  expect(second.status, second.stderr).toBe(0)
  const repeated = JSON.parse(second.stdout) as SeedOutput
  expect(repeated.alreadySeeded, 'a second seed reports the loaded profile').toBe(true)
  expect(
    Number(queryDatabase(databaseUrl, 'select count(*) from events')[0]),
    'a second seed appends nothing'
  ).toBe(eventsBefore)
}, 180_000)

test('#234 DE-4 the demo people use the flow and the in-flight instances', async () => {
  const { publicUrl, adminToken } = requireSetup()
  const { seed, samToken, okaforToken } = requireSeedState()
  const slug = seed.flow?.slug ?? ''

  const flows = await json<readonly FlowSummary[]>(
    await userFetch(samToken, '/api/v1/flows'),
    'GET /api/v1/flows as Sam'
  )
  expect(
    flows.map((flow) => flow.slug),
    'Sam lists the demo flow through instance.start'
  ).toContain(slug)

  const published = await json<{ slug: string; definition: FlowDefinition }>(
    await userFetch(samToken, `/api/v1/flows/${slug}`),
    'GET the demo flow as Sam'
  )
  expect(published.slug).toBe(slug)
  expect(published.definition.steps.map((step) => step.key)).toEqual([
    'chair',
    'request',
    'advisor',
    'registrar',
  ])

  const first = seed.instances?.find((instance) => instance.step === 'request')
  if (first === undefined) throw new Error('the seed has no request instance')
  const view = await json<{
    instanceId: string
    status: { currentStep?: string }
    values: Record<string, unknown>
  }>(await userFetch(samToken, `/api/v1/instances/${first.id}`), 'GET the request instance as Sam')
  expect(view.instanceId).toBe(first.id)
  expect(view.status.currentStep, 'the first instance waits unclaimed at request').toBe('request')
  expect(view.values.credits).toBe(2)

  const okaforFlows = await json<readonly FlowSummary[]>(
    await userFetch(okaforToken, '/api/v1/flows'),
    'GET /api/v1/flows as Okafor'
  )
  expect(
    okaforFlows.map((flow) => flow.slug),
    'Okafor reads the demo flow'
  ).toContain(slug)

  const advisor = seed.instances?.find((instance) => instance.step === 'advisor')
  if (advisor === undefined) throw new Error('the seed has no advisor instance')
  const available = await json<readonly InboxItem[]>(
    await userFetch(okaforToken, '/api/v1/inbox?tab=available'),
    'GET Okafor available inbox'
  )
  expect(available.find((item) => item.instanceId === advisor.id)).toMatchObject({
    flowSlug: slug,
    step: 'advisor',
    state: 'unopened',
  })

  const started = await json<readonly InboxItem[]>(
    await userFetch(samToken, '/api/v1/inbox?tab=started'),
    'GET Sam started inbox'
  )
  expect(
    started
      .filter((item) => item.flowSlug === slug)
      .map((item) => item.instanceId)
      .sort()
  ).toEqual(
    seed.instances
      ?.filter((instance) => !instance.done)
      .map((instance) => instance.id)
      .sort()
  )

  expect(
    (await userFetch(adminToken, `/api/v1/flows/${slug}`)).status,
    'the administrator reads the demo flow too'
  ).toBe(200)
  expect(publicUrl).toContain('127.0.0.1')
}, 180_000)

test('#234 I4 seed clear removes only the demo records and the demo tokens stop working', async () => {
  const { configPath, databaseUrl } = requireSetup()
  const { seed, samToken } = requireSeedState()
  const slug = seed.flow?.slug ?? ''
  const demoInstanceIds = seed.instances?.map((instance) => instance.id) ?? []

  // Real data that the clear must leave alone.
  await adminJson('/api/v1/flows', {
    method: 'POST',
    body: JSON.stringify({ slug: REAL_SLUG, title: 'A real flow' }),
  })

  const unconfirmed = runCli(['seed', 'clear', '--config', configPath])
  expect(unconfirmed.status, 'a clear without --yes is refused').toBe(1)
  expect(unconfirmed.stderr).toContain('--yes')
  expect(seedRecordCount(true), 'the refused clear removes nothing').toBe(seed.records)

  const result = runCli(['seed', 'clear', '--config', configPath, '--yes', '--json'])
  expect(result.status, result.stderr).toBe(0)
  const cleared = JSON.parse(result.stdout) as SeedOutput
  expect(cleared.ok).toBe(true)
  expect(cleared.cleared?.users).toHaveLength(6)
  expect(cleared.cleared?.teams).toHaveLength(2)
  expect(cleared.cleared?.groups).toHaveLength(1)
  expect(cleared.cleared?.flows.map((record) => record.id)).toEqual([slug])
  expect(cleared.cleared?.instances).toHaveLength(4)
  expect(cleared.cleared?.grants.length, 'the seeded grants are removed').toBeGreaterThan(5)
  expect(cleared.operationId, 'the clear appended its event').toMatch(/./)
  expect(seedRecordCount(true), 'no live seed record is left').toBe(0)

  const samAfter = await userFetch(samToken, '/api/v1/flows')
  expect(samAfter.status, 'the deleted demo user no longer authenticates').toBe(401)

  const flow = await adminFetch(`/api/v1/flows/${slug}`)
  expect(flow.status, await flow.text()).toBe(404)
  const draft = await adminFetch(`/api/v1/flows/${slug}/draft`)
  expect(draft.status, await draft.text()).toBe(404)
  for (const instanceId of demoInstanceIds) {
    const instance = await adminFetch(`/api/v1/instances/${instanceId}`)
    expect(instance.status, `the cleared instance ${instanceId} answers 404`).toBe(404)
  }

  const flows = await adminJson<readonly FlowSummary[]>('/api/v1/flows')
  expect(
    flows.map((flow) => flow.slug),
    'the demo flow is absent'
  ).not.toContain(slug)
  expect(
    flows.map((flow) => flow.slug),
    'the real flow survives'
  ).toContain(REAL_SLUG)
  for (const tab of ['my', 'available', 'started'] as const) {
    expect(await adminInbox(tab), `the cleared demo leaves ${tab} empty`).toEqual([])
  }

  const log = await adminJson<readonly Event[]>('/api/v1/log')
  expect(log.some((event) => event.type === 'instance.started@1')).toBe(true)
  expect(log.find((event) => event.type === 'seed.cleared@1')).toMatchObject({
    payload: { profile: DEMO_PROFILE },
  })
  expect(
    Number(
      queryDatabase(databaseUrl, 'select count(*) from seed_records where cleared_at is null')[0]
    ),
    'the log keeps the events and the records keep their clear mark'
  ).toBe(0)
}, 180_000)

test('#234 I4 a rebuild after the clear never resurrects the demo', async () => {
  const { configPath, databaseUrl, adminToken, publicUrl } = requireSetup()
  const { seed, samToken } = requireSeedState()
  const slug = seed.flow?.slug ?? ''
  const demoInstanceIds = seed.instances?.map((instance) => instance.id) ?? []

  const result = runCli(['admin', 'rebuild', '--config', configPath])
  expect(result.status, result.stderr).toBe(0)

  const flow = await adminFetch(`/api/v1/flows/${slug}`)
  expect(flow.status, await flow.text()).toBe(404)
  const draft = await adminFetch(`/api/v1/flows/${slug}/draft`)
  expect(draft.status, await draft.text()).toBe(404)
  for (const instanceId of demoInstanceIds) {
    const instance = await adminFetch(`/api/v1/instances/${instanceId}`)
    expect(instance.status, `the rebuilt cleared instance ${instanceId} answers 404`).toBe(404)
  }
  const flows = await adminJson<readonly FlowSummary[]>('/api/v1/flows')
  expect(flows.map((flow) => flow.slug)).not.toContain(slug)
  expect(
    flows.map((flow) => flow.slug),
    'the real flow survives the rebuild'
  ).toContain(REAL_SLUG)

  expect(
    queryDatabase(databaseUrl, `select count(*) from flows where slug = '${slug}'`)[0],
    'the flow projection stays deleted'
  ).toBe('0')
  expect(
    queryDatabase(
      databaseUrl,
      `select count(*) from instances where id in (${demoInstanceIds.map((id) => `'${id}'`).join(',')})`
    )[0],
    'the instance projections stay deleted'
  ).toBe('0')
  expect(
    seedRecordCount(false),
    'the cleared records persist for the next rebuild'
  ).toBeGreaterThan(0)

  const samAfter = await userFetch(samToken, '/api/v1/flows')
  expect(samAfter.status, 'the demo user stays deleted through a rebuild').toBe(401)

  const real = await fetch(`${publicUrl}/api/v1/flows/${REAL_SLUG}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  expect(real.status, 'the real administrator still reads the real data').not.toBe(401)
  expect(await real.text()).toContain(REAL_SLUG)
}, 180_000)
