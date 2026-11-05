import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { json, passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #256, S16, S10, WF-5, D6, A2, I4, I5, I8, I14: undo a mistake against
// the real stack. Okafor claims and approves the demo's advisor instance, then
// undoes the approval: the compensating event restores the advisor step with
// him as its holder, the original approval stays on the log, the registrar
// team no longer sees the task, and a rebuild reproduces the state. A peer
// may not undo his claim, a flow owner (`task.reassign`) may, a stale view is
// refused, and the undo of an action that is not the latest is refused with
// the reason.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `undo-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'undo-admin-password'
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

type TimelineEntry = { readonly seq: number; readonly type: string; readonly actor?: string }

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
    const dir = mkdtempSync(join(tmpdir(), 'enform-undo-'))
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

function readInstance(token: string, instanceId: string): Promise<InstanceView> {
  return apiJson<InstanceView>(token, `/api/v1/instances/${instanceId}`)
}

async function inboxIds(token: string, tab: string): Promise<string[]> {
  const items = await apiJson<readonly { readonly instanceId: string }[]>(
    token,
    `/api/v1/inbox?tab=${tab}`
  )
  return items.map((item) => item.instanceId)
}

test('#256 S16 the actor undoes an approval, a flow owner undoes the claim, and the log keeps every event', async () => {
  const { config, seed, configPath } = requireSetup()
  const slug = seed.flow?.slug ?? ''
  const okafor = demoUser('advisor')
  const ana = demoUser('registrar')
  const priya = demoUser('reader')
  const tokens = {
    admin: await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD),
    okafor: await passwordToken(config, okafor.email, okafor.password),
    ana: await passwordToken(config, ana.email, ana.password),
    priya: await passwordToken(config, priya.email, priya.password),
  }
  const instanceId = seed.instances?.find((instance) => instance.step === 'advisor')?.id ?? ''
  expect(instanceId, 'the seed has an advisor instance').not.toBe('')

  // Okafor claims and approves (S09); the instance moves to the registrar.
  const draft = await readInstance(tokens.okafor, instanceId)
  const claimed = await postIntent(tokens.okafor, {
    type: 'step.claimed@1',
    actor: okafor.id,
    payload: { instanceId, expectedVersion: draft.version },
  })
  expect(claimed.status, await claimed.text()).toBe(201)
  const held = await readInstance(tokens.okafor, instanceId)
  const approved = await postIntent(tokens.okafor, {
    type: 'step.completed@1',
    actor: okafor.id,
    payload: { instanceId, version: held.version, outcome: 'approve', values: {} },
  })
  expect(approved.status, await approved.text()).toBe(201)
  const atRegistrar = await readInstance(tokens.okafor, instanceId)
  expect(atRegistrar.status.currentStep).toBe('registrar')
  expect(await inboxIds(tokens.ana, 'available')).toContain(instanceId)

  // The timeline names the approval's seq (I4).
  const timeline = await apiJson<readonly TimelineEntry[]>(
    tokens.okafor,
    `/api/v1/instances/${instanceId}/timeline`
  )
  const approval = timeline.filter((entry) => entry.type === 'step.completed@1').at(-1)
  const claim = timeline.filter((entry) => entry.type === 'step.claimed@1').at(-1)
  if (approval === undefined || claim === undefined)
    throw new Error('the timeline lacks the events')

  // A stale view is refused (I5), and the claim under the approval is not the
  // latest action (D6).
  const stale = await postIntent(tokens.okafor, {
    type: 'event.undone@1',
    actor: okafor.id,
    payload: { instanceId, eventId: approval.seq, reason: 'Wrong request', version: 0 },
  })
  expect(stale.status).toBe(409)
  const notLatest = await postIntent(tokens.okafor, {
    type: 'event.undone@1',
    actor: okafor.id,
    payload: {
      instanceId,
      eventId: claim.seq,
      reason: 'Wrong request',
      version: atRegistrar.version,
    },
  })
  expect(notLatest.status).toBe(409)
  expect(((await notLatest.json()) as { error: string }).error).toMatch(/latest/)

  // Okafor undoes the approval: the advisor step is his again, the registrar
  // team no longer sees the task, and the original approval stays (S16, I4).
  const undone = await postIntent(tokens.okafor, {
    type: 'event.undone@1',
    actor: okafor.id,
    payload: {
      instanceId,
      eventId: approval.seq,
      reason: 'Approved the wrong request',
      version: atRegistrar.version,
    },
  })
  expect(undone.status, await undone.text()).toBe(201)
  const restored = await readInstance(tokens.okafor, instanceId)
  expect(restored.status).toMatchObject({
    currentStep: 'advisor',
    holder: okafor.id,
    state: 'in-progress',
  })
  expect(restored.version).toBe(atRegistrar.version + 1)
  expect(restored.tracker.map((step) => [step.key, step.state])).toEqual([
    ['request', 'completed'],
    ['advisor', 'opened'],
    ['chair', 'not-reached'],
    ['registrar', 'not-reached'],
  ])
  expect(await inboxIds(tokens.ana, 'available')).not.toContain(instanceId)
  expect(await inboxIds(tokens.okafor, 'my')).toContain(instanceId)
  const after = await apiJson<readonly TimelineEntry[]>(
    tokens.okafor,
    `/api/v1/instances/${instanceId}/timeline`
  )
  expect(after.map((entry) => entry.type)).toContain('step.completed@1')
  expect(after.at(-1)).toMatchObject({ type: 'event.undone@1', actor: okafor.id })

  // Ana neither claimed nor owns the flow: 403 (I8). The administrator makes
  // Priya a flow owner, and she undoes the claim: the task is back in the pool.
  const peer = await postIntent(tokens.ana, {
    type: 'event.undone@1',
    actor: ana.id,
    payload: { instanceId, eventId: claim.seq, reason: 'Not mine', version: restored.version },
  })
  expect(peer.status, await peer.text()).toBe(403)
  const granted = await postIntent(tokens.admin, {
    type: 'config.grant.changed@1',
    actor: 'ignored',
    payload: { principal: priya.id, scopes: ['task.reassign'], resource: `flow:${slug}` },
  })
  expect(granted.status, await granted.text()).toBe(201)
  const owner = await postIntent(tokens.priya, {
    type: 'event.undone@1',
    actor: priya.id,
    payload: {
      instanceId,
      eventId: claim.seq,
      reason: 'Okafor is away',
      version: restored.version,
    },
  })
  expect(owner.status, await owner.text()).toBe(201)
  const pooled = await readInstance(tokens.okafor, instanceId)
  expect(pooled.status).toMatchObject({ currentStep: 'advisor', state: 'waiting' })
  expect(pooled.status.holder).toBeUndefined()
  expect(await inboxIds(tokens.okafor, 'available')).toContain(instanceId)

  // A rebuild reproduces the same read from the log (I4).
  const rebuilt = runCli(['admin', 'rebuild', '--config', configPath, '--json'])
  expect(rebuilt.status, rebuilt.stderr).toBe(0)
  const again = await readInstance(tokens.okafor, instanceId)
  expect(again).toEqual(pooled)
  expect(await inboxIds(tokens.okafor, 'available')).toContain(instanceId)
}, 120_000)
