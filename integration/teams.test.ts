import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #256, AS-6, AC-2, I4, I8, I14, S02, S08: teams and grant revokes
// against the real stack. The first administrator creates a team, adds and
// removes a member, and a principal without `org.teams` is refused; the
// administrator grants Lee `instance.read` on the demo flow and revokes it
// again, and Lee's read answers 200 then 403; a rebuild reproduces both
// projections and the log keeps every attributed change.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `teams-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'teams-admin-password'
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
    const dir = mkdtempSync(join(tmpdir(), 'enform-teams-'))
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

async function postIntent(token: string, body: Record<string, unknown>): Promise<Response> {
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

test('#256 AS-6 the administrator creates and maintains a team, and a peer may not', async () => {
  const { config, seed, configPath } = requireSetup()
  const ana = demoUser('registrar', 0)
  const lee = demoUser('registrar', 1)
  const tokens = {
    admin: await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD),
    ana: await passwordToken(config, ana.email, ana.password),
  }
  const team = `office-${RUN}`

  const created = await postIntent(tokens.admin, {
    type: 'config.team.changed@1',
    actor: 'ignored',
    payload: { team, change: 'created' },
  })
  expect(created.status, await created.text()).toBe(201)
  const added = await postIntent(tokens.admin, {
    type: 'config.team.changed@1',
    actor: 'ignored',
    payload: { team, change: 'member-added', member: ana.id },
  })
  expect(added.status, await added.text()).toBe(201)
  const teams = await apiJson<readonly { name: string; members: string[] }[]>(
    tokens.ana,
    '/api/v1/teams'
  )
  expect(teams.find((entry) => entry.name === team)?.members).toEqual([ana.id])
  // The demo's own teams are projected from the log too (I4).
  expect(teams.some((entry) => entry.members.includes(lee.id))).toBe(true)

  // Ana holds no org.teams: refused (AS-6, I8).
  const peer = await postIntent(tokens.ana, {
    type: 'config.team.changed@1',
    actor: ana.id,
    payload: { team, change: 'member-added', member: lee.id },
  })
  expect(peer.status, await peer.text()).toBe(403)
  const unknown = await postIntent(tokens.admin, {
    type: 'config.team.changed@1',
    actor: 'ignored',
    payload: { team: `nope-${RUN}`, change: 'member-added', member: lee.id },
  })
  expect(unknown.status).toBe(409)

  const removed = await postIntent(tokens.admin, {
    type: 'config.team.changed@1',
    actor: 'ignored',
    payload: { team, change: 'member-removed', member: ana.id },
  })
  expect(removed.status, await removed.text()).toBe(201)
  const after = await apiJson<readonly { name: string; members: string[] }[]>(
    tokens.ana,
    '/api/v1/teams'
  )
  expect(after.find((entry) => entry.name === team)?.members).toEqual([])
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath, '--json'])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  expect(await apiJson(tokens.ana, '/api/v1/teams')).toEqual(after)
  expect(seed.flow?.slug).toBeTruthy()
}, 120_000)

test('#256 AC-2 a revoke removes the named scopes and a rebuild agrees', async () => {
  const { config, seed, configPath } = requireSetup()
  const slug = seed.flow?.slug ?? ''
  const lee = demoUser('registrar', 1)
  const tokens = {
    admin: await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD),
    lee: await passwordToken(config, lee.email, lee.password),
  }
  const instanceId = seed.instances?.find((instance) => instance.step === 'advisor')?.id ?? ''
  const resource = `flow:${slug}`

  // Lee is no assignee of the advisor instance: 403 until the administrator
  // grants him instance.read on the flow, then 200 (I8).
  expect((await api(tokens.lee, `/api/v1/instances/${instanceId}`)).status).toBe(403)
  const granted = await postIntent(tokens.admin, {
    type: 'config.grant.changed@1',
    actor: 'ignored',
    payload: { principal: lee.id, scopes: ['instance.read', 'instance.timeline'], resource },
  })
  expect(granted.status, await granted.text()).toBe(201)
  expect((await api(tokens.lee, `/api/v1/instances/${instanceId}`)).status).toBe(200)

  // The revoke of instance.read leaves instance.timeline in place (AC-2).
  const revoked = await postIntent(tokens.admin, {
    type: 'config.grant.changed@1',
    actor: 'ignored',
    payload: { principal: lee.id, scopes: ['instance.read'], resource, change: 'revoked' },
  })
  expect(revoked.status, await revoked.text()).toBe(201)
  expect((await api(tokens.lee, `/api/v1/instances/${instanceId}`)).status).toBe(403)
  const grants = await apiJson<
    readonly { principal: string; scopes: string[]; resource: string }[]
  >(tokens.admin, `/api/v1/flows/${slug}/grants`)
  const lees = grants.filter((grant) => grant.principal === lee.id && grant.resource === resource)
  expect(lees.flatMap((grant) => grant.scopes)).toEqual(['instance.timeline'])

  // Both changes are attributed on the log (I14), and a rebuild agrees (I4).
  const log = await apiJson<
    readonly { type: string; actor?: string; payload: Record<string, unknown> }[]
  >(tokens.admin, '/api/v1/log')
  const changes = log.filter(
    (event) => event.type === 'config.grant.changed@1' && event.payload.principal === lee.id
  )
  expect(changes.map((event) => event.payload.change ?? 'added')).toEqual(['added', 'revoked'])
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath, '--json'])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  expect((await api(tokens.lee, `/api/v1/instances/${instanceId}`)).status).toBe(403)
  expect(await apiJson(tokens.admin, `/api/v1/flows/${slug}/grants`)).toEqual(grants)
}, 120_000)
