import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { FlowDefinition } from '../engine/definition.js'
import { STARTER_DEFINITION } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { createUser, json, keycloakAdminToken, passwordToken, readSession } from './auth.js'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #220, #218, DF-1, DF-2, DF-4, DF-5, DE-1, DX-1, I4, I5, I8, I14, ADR
// 0013: the flow API against a real PostgreSQL and a real Keycloak. `enform
// init` writes the configuration, creates the database, migrates it, creates
// the first administrator and serves the configured URL. The test then uses
// HTTP only: create, list, read the draft, write a structural change, publish,
// read the published flow, prove that a stale write appends nothing, rebuild
// the projections from the log and prove that a user without the scope cannot
// create a flow.

const RUN = randomUUID().slice(0, 8)
const SLUG = `demo-${RUN}`
const UNKNOWN = `missing-${RUN}`
const ADMIN_EMAIL = `flow-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'flow-admin-password'
const REPO = join(import.meta.dirname, '..')

/** One response body of the flow API (api/openapi.yaml). */
type DraftFlow = {
  readonly slug: string
  readonly version: number
  readonly definition: FlowDefinition
}

type FlowSummary = {
  readonly slug: string
  readonly title?: string
  readonly draftVersion: number
  readonly publishedVersion?: number
  readonly updatedAt: number
}

type PublishedFlow = {
  readonly slug: string
  readonly version: number
  readonly contentHash: string
  readonly definition: FlowDefinition
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

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-flows-'))
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
  if (setup === undefined) {
    throw setupError ?? new Error('integration: the shared setup did not run')
  }
  return setup
}

/** The two-step definition that the draft write records: request, then approve. */
function twoStep(adminId: string): FlowDefinition {
  return {
    schemaVersion: 2,
    steps: [
      { key: 'request', targets: [{ starter: 'starter' }] },
      { key: 'approve', targets: [{ user: adminId }] },
    ],
  }
}

/** Call one flow path with the administrator's bearer token. */
async function adminFetch(
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<Response> {
  const { publicUrl, adminToken } = requireSetup()
  const headers: Record<string, string> = { authorization: `Bearer ${adminToken}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${publicUrl}${path}`, { ...init, headers })
}

/** Call one flow path and read its JSON body, or name the request that failed. */
async function adminJson<T>(
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<T> {
  return json<T>(await adminFetch(path, init), `${init.method ?? 'GET'} ${path}`)
}

test('#220 an administrator creates a flow, lists it and reads the starter draft', async () => {
  const created = await adminJson<DraftFlow>('/api/v1/flows', {
    method: 'POST',
    body: JSON.stringify({ slug: SLUG, title: 'Demo flow' }),
  })
  expect(created).toEqual({ slug: SLUG, version: 1, definition: STARTER_DEFINITION })

  const summaries = await adminJson<readonly FlowSummary[]>('/api/v1/flows')
  const summary = summaries.find((entry) => entry.slug === SLUG)
  expect(summary, 'the new flow is listed').toBeDefined()
  expect(summary?.title, 'the title is projected').toBe('Demo flow')
  expect(summary?.draftVersion, 'the first draft publishes as version 1').toBe(1)
  expect(summary?.publishedVersion, 'nothing is published yet').toBeUndefined()
  expect(typeof summary?.updatedAt, 'the list carries the newest event time').toBe('number')

  const draft = await adminJson<DraftFlow>(`/api/v1/flows/${SLUG}/draft`)
  expect(draft).toEqual({ slug: SLUG, version: 1, definition: STARTER_DEFINITION })
})

test('#220 a structural draft write records version 1 and returns the definition', async () => {
  const { adminId } = requireSetup()
  const definition = twoStep(adminId)
  const written = await adminJson<DraftFlow>(`/api/v1/flows/${SLUG}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ version: 1, definition }),
  })
  expect(written).toEqual({ slug: SLUG, version: 1, definition })
})

test('#220 publishing freezes version 1 and the list opens draft version 2', async () => {
  const { adminId } = requireSetup()
  const published = await adminJson<PublishedFlow>(`/api/v1/flows/${SLUG}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version: 1 }),
  })
  expect(published.slug).toBe(SLUG)
  expect(published.version, 'the first publication is version 1').toBe(1)
  expect(published.contentHash, 'the version has the content hash of its definition').toBe(
    contentHash(twoStep(adminId))
  )
  expect(published.definition).toEqual(twoStep(adminId))

  const summaries = await adminJson<readonly FlowSummary[]>('/api/v1/flows')
  const summary = summaries.find((entry) => entry.slug === SLUG)
  expect(summary?.publishedVersion, 'the list shows the published version').toBe(1)
  expect(summary?.draftVersion, 'the next draft publishes as version 2').toBe(2)
})

test('#220 a stale draft write answers 409 and appends nothing (I5)', async () => {
  const { databaseUrl, adminId } = requireSetup()
  const beforeDraft = await adminJson<DraftFlow>(`/api/v1/flows/${SLUG}/draft`)
  expect(beforeDraft.version, 'the draft version advanced with the publication').toBe(2)
  const beforeEvents = queryDatabase(databaseUrl, 'select count(*) from events')

  const response = await adminFetch(`/api/v1/flows/${SLUG}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ version: 1, definition: twoStep(adminId) }),
  })
  const body = await response.text()
  expect(response.status, body).toBe(409)
  expect(JSON.parse(body), 'the refusal names the stale version').toMatchObject({
    code: 'version-stale',
  })

  expect(queryDatabase(databaseUrl, 'select count(*) from events'), 'nothing was appended').toEqual(
    beforeEvents
  )
  expect(
    await adminJson<DraftFlow>(`/api/v1/flows/${SLUG}/draft`),
    'the draft is unchanged'
  ).toEqual(beforeDraft)
})

test('#220 the published read returns the frozen definition and an unknown slug answers 404', async () => {
  const { adminId } = requireSetup()
  const published = await adminJson<PublishedFlow>(`/api/v1/flows/${SLUG}`)
  expect(published).toEqual({
    slug: SLUG,
    version: 1,
    contentHash: contentHash(twoStep(adminId)),
    definition: twoStep(adminId),
  })

  const missing = await adminFetch(`/api/v1/flows/${UNKNOWN}`)
  expect(missing.status, await missing.text()).toBe(404)
})

test('#220 enform admin rebuild reproduces the list and the draft from the log (I4)', async () => {
  const { configPath } = requireSetup()
  const beforeList = await adminJson<readonly FlowSummary[]>('/api/v1/flows')
  const beforeDraft = await adminJson<DraftFlow>(`/api/v1/flows/${SLUG}/draft`)

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

  expect(await adminJson<readonly FlowSummary[]>('/api/v1/flows'), 'the list is unchanged').toEqual(
    beforeList
  )
  expect(
    await adminJson<DraftFlow>(`/api/v1/flows/${SLUG}/draft`),
    'the draft is unchanged'
  ).toEqual(beforeDraft)
})

test('#220 a user without the scope cannot create a flow and lists nothing (I8)', async () => {
  const { config, publicUrl } = requireSetup()
  const adminToken = await keycloakAdminToken(config)
  const username = `outsider-${RUN}`
  const user = {
    username,
    email: `${username}@test.local`,
    firstName: 'Out',
    lastName: 'Sider',
    password: 'outsider-password',
  }
  await createUser(config, adminToken, user)
  const token = await passwordToken(config, user.username, user.password)
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const deniedSlug = `denied-${RUN}`
  const response = await fetch(`${publicUrl}/api/v1/flows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ slug: deniedSlug }),
  })
  expect(response.status, await response.text()).toBe(403)

  const list = await fetch(`${publicUrl}/api/v1/flows`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(
    await json<readonly FlowSummary[]>(list, 'GET /api/v1/flows as the outsider'),
    'the outsider reads no flow'
  ).toEqual([])

  const missing = await adminFetch(`/api/v1/flows/${deniedSlug}/draft`)
  expect(missing.status, 'the refused creation appended nothing').toBe(404)
})
