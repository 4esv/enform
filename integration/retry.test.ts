import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #256, I1, I4, ADR 0010, S07: a retry of a client intent against the
// real stack. A client whose first answer was lost (a dropped connection, a
// reconnection that resends its queue) posts the same intent with the same
// id again. The server answers the event the log holds, with the same seq,
// and resolves nothing again: a second resolution of a submit would refuse
// the draft as already submitted, and the client would read a refusal for a
// change that landed.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `retry-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'retry-admin-password'
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
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly seed: SeedOutput
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-retry-'))
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
    const seeded = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(REPO, 'cli', 'main.ts'),
        'seed',
        'demo',
        '--config',
        configPath,
        '--json',
      ],
      { cwd: REPO, encoding: 'utf8' }
    )
    if (seeded.status !== 0) throw new Error(`the demo seed failed: ${seeded.stderr}`)
    setup = { config, dir, publicUrl, service, seed: JSON.parse(seeded.stdout) }
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

test('#256 I1 a retry of an applied intent answers the applied event and the log does not grow', async () => {
  const { config, seed, publicUrl } = requireSetup()
  const sam = seed.users?.find((user) => user.role === 'starter')
  const slug = seed.flow?.slug
  if (sam === undefined || slug === undefined) throw new Error('the seed has no starter or flow')
  const token = await passwordToken(config, sam.email, sam.password)
  const post = (body: unknown) =>
    fetch(`${publicUrl}/api/v1/operations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const readLog = async (): Promise<readonly { seq: number; operationId: string }[]> => {
    const response = await fetch(`${publicUrl}/api/v1/log`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return (await response.json()) as readonly { seq: number; operationId: string }[]
  }

  const instanceId = randomUUID()
  const start = {
    id: randomUUID(),
    type: 'instance.started@1',
    at: Date.now(),
    actor: sam.id,
    payload: { flow: slug, instanceId, values: {} },
  }
  const started = await post(start)
  expect(started.status, await started.clone().text()).toBe(201)
  const submit = {
    id: randomUUID(),
    type: 'instance.submitted@1',
    at: Date.now(),
    actor: sam.id,
    payload: { instanceId, version: 0, values: { summary: 'retry', credits: 1 } },
  }
  const first = await post(submit)
  expect(first.status, await first.clone().text()).toBe(201)
  const event = (await first.json()) as { seq: number; operationId: string }
  const before = (await readLog()).length

  // The same intent again: the same change, so the same event (I1).
  const again = await post(submit)
  expect(again.status, await again.clone().text()).toBe(201)
  const repeated = (await again.json()) as { seq: number; operationId: string }
  expect(repeated.seq).toBe(event.seq)
  expect(repeated.operationId).toBe(submit.id)
  expect((await readLog()).length).toBe(before)
})
