import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #256, RT-6, S04, DF-2, DF-5, DF-6, A7, I4: a published change
// reaches an open draft against the real stack. The administrator adds a
// required field to the demo flow's request form and publishes version 2;
// Sam's open draft moves to version 2 when he opens it, with the new required
// field named and every value kept, while the submitted instances stay on
// version 1; the draft write names the field-level change with its path, and a
// rebuild reproduces the read.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `rebind-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'rebind-admin-password'
const REPO = join(import.meta.dirname, '..')

type DemoUser = {
  readonly role: string
  readonly email: string
  readonly id: string
  readonly password: string
}

type SeedOutput = {
  readonly flow?: { readonly slug: string }
  readonly users?: readonly DemoUser[]
  readonly instances?: readonly { readonly id: string; readonly step: string }[]
}

type InstanceView = {
  readonly version: number
  readonly status: {
    readonly currentStep?: string
    readonly holder?: string
    readonly state: string
  }
  readonly tracker: readonly { readonly key: string; readonly state: string }[]
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly seed: SeedOutput
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-rebind-'))
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
    setup = { config, dir, configPath, publicUrl, service, seed: JSON.parse(seeded.stdout) }
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

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

function demoUser(role: string, index = 0): DemoUser {
  const users = requireSetup().seed.users?.filter((user) => user.role === role) ?? []
  const user = users[index]
  if (user === undefined) throw new Error(`the seed has no ${role} user`)
  return user
}

async function api(
  token: string,
  path: string,
  init: { readonly method?: string; readonly body?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${requireSetup().publicUrl}${path}`, { ...init, headers })
}

async function apiJson<T>(token: string, path: string): Promise<T> {
  return json<T>(await api(token, path), `GET ${path}`)
}

async function _postIntent(token: string, body: Record<string, unknown>): Promise<Response> {
  return api(token, '/api/v1/operations', {
    method: 'POST',
    body: JSON.stringify({ id: randomUUID(), at: Date.now(), ...body }),
  })
}

function _readInstance(token: string, instanceId: string): Promise<InstanceView> {
  return apiJson<InstanceView>(token, `/api/v1/instances/${instanceId}`)
}

async function _inboxIds(token: string, tab: string): Promise<string[]> {
  const items = await apiJson<readonly { readonly instanceId: string }[]>(
    token,
    `/api/v1/inbox?tab=${tab}`
  )
  return items.map((item) => item.instanceId)
}

type DraftFlow = {
  readonly version: number
  readonly definition: { readonly steps: Record<string, unknown>[]; [key: string]: unknown }
}

test('#256 RT-6 an open draft rebinds to the published version and names the new field', async () => {
  const { config, seed, configPath } = requireSetup()
  const slug = seed.flow?.slug ?? ''
  const sam = demoUser('starter')
  const okafor = demoUser('advisor')
  const tokens = {
    admin: await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD),
    sam: await passwordToken(config, sam.email, sam.password),
    okafor: await passwordToken(config, okafor.email, okafor.password),
  }
  const draftId = seed.instances?.find((instance) => instance.step === 'request')?.id ?? ''
  const advisorId = seed.instances?.find((instance) => instance.step === 'advisor')?.id ?? ''
  const before = await apiJson<InstanceView & { rebound?: unknown; values: unknown }>(
    tokens.sam,
    `/api/v1/instances/${draftId}`
  )
  expect(before.status.state).toBe('draft')
  expect(before.rebound).toBeUndefined()

  // The administrator adds a required field to the request form; the write
  // names the structural change with its path (DF-5, DF-6).
  const draft = await apiJson<DraftFlow>(tokens.admin, `/api/v1/flows/${slug}/draft`)
  const request = draft.definition.steps[0]
  const fields = [
    ...(request.fields as Record<string, unknown>[]),
    { key: 'reason_category', control: 'text', label: 'Reason', required: true },
  ]
  const definition = {
    ...draft.definition,
    steps: [
      { ...request, fields, editable: [...(request.editable as string[]), 'reason_category'] },
      ...draft.definition.steps.slice(1),
    ],
  }
  const written = await api(tokens.admin, `/api/v1/flows/${slug}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ version: draft.version, definition }),
  })
  const writtenText = await written.text()
  expect(written.status, writtenText).toBe(200)
  const writtenDraft = JSON.parse(writtenText) as DraftFlow & {
    changes?: { path: string; class: string }[]
  }
  expect(writtenDraft.changes?.map((change) => [change.class, change.path])).toEqual([
    ['structural', '/steps/request/fields/reason_category'],
    ['structural', '/steps/request/editable'],
  ])
  const published = await api(tokens.admin, `/api/v1/flows/${slug}/publish`, {
    method: 'POST',
    body: JSON.stringify({ version: writtenDraft.version }),
  })
  const publishedText = await published.text()
  expect(published.status, publishedText).toBe(200)
  const v2 = JSON.parse(publishedText) as { contentHash: string; version: number }
  expect(v2.version).toBe(2)

  // Sam opens his draft: it is on version 2, the new required field is named,
  // and his values stay (RT-6, A7).
  const after = await apiJson<
    InstanceView & {
      rebound?: { from: string; to: string; misfits: unknown[]; newRequired: string[] }
      values: Record<string, unknown>
      required: string[]
    }
  >(tokens.sam, `/api/v1/instances/${draftId}`)
  expect(after.rebound).toMatchObject({
    to: v2.contentHash,
    misfits: [],
    newRequired: ['reason_category'],
  })
  expect(after.rebound?.from).not.toBe(v2.contentHash)
  expect(after.values).toEqual(before.values)
  expect(after.required).toContain('reason_category')
  // The submitted instance stays on version 1 (DF-2): no rebind, no new field.
  const submitted = await apiJson<InstanceView & { rebound?: unknown; required: string[] }>(
    tokens.okafor,
    `/api/v1/instances/${advisorId}`
  )
  expect(submitted.rebound).toBeUndefined()
  // The log holds one attributed rebind, and a second read appends none (I1, I4).
  const again = await apiJson<InstanceView & { rebound?: unknown }>(
    tokens.sam,
    `/api/v1/instances/${draftId}`
  )
  expect(again).toEqual(after)
  const log = await apiJson<
    readonly { type: string; actor?: string; payload: Record<string, unknown> }[]
  >(tokens.admin, '/api/v1/log')
  const rebinds = log.filter((event) => event.type === 'draft.rebound@1')
  expect(rebinds).toHaveLength(1)
  expect(rebinds[0]?.actor).toBe(sam.id)
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath, '--json'])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  expect(await apiJson(tokens.sam, `/api/v1/instances/${draftId}`)).toEqual(after)
}, 120_000)
