import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { passwordToken } from './auth.js'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #260, RT-1, RT-2, DX-2, I4, I8, ADR 0006: the realtime channel
// against the real stack. Sam opens a WebSocket with his bearer credential,
// subscribes to his draft, and a submit through the API reaches him as a
// change without a payload, through the log channel that every append
// notifies. The Server-Sent Events fallback and the polling read see the
// same event; an unreadable instance is refused on the channel and on the
// stream (I8); presence shows a second viewer.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `realtime-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'realtime-admin-password'
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
    const dir = mkdtempSync(join(tmpdir(), 'enform-realtime-'))
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

function demoUser(role: string, index = 0): DemoUser {
  const users = requireSetup().seed.users?.filter((user) => user.role === role) ?? []
  const user = users[index]
  if (user === undefined) throw new Error(`the seed has no ${role} user`)
  return user
}

type Client = { readonly ws: WebSocket; readonly next: () => Promise<Record<string, unknown>> }

/** A WebSocket client with a bearer token, and a queue of what it received. */
function connect(token: string): Promise<Client> {
  const { publicUrl } = requireSetup()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${publicUrl.replace('http', 'ws')}/api/v1/realtime`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const queue: Record<string, unknown>[] = []
    const waiting: ((message: Record<string, unknown>) => void)[] = []
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>
      const waiter = waiting.shift()
      if (waiter === undefined) queue.push(message)
      else waiter(message)
    })
    ws.on('open', () =>
      resolve({
        ws,
        next: () =>
          new Promise((answer, fail) => {
            const queued = queue.shift()
            if (queued !== undefined) answer(queued)
            else {
              waiting.push(answer)
              setTimeout(() => fail(new Error('no message within 20 s')), 20_000)
            }
          }),
      })
    )
    ws.on('error', (error) => reject(error))
  })
}

async function post(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${requireSetup().publicUrl}/api/v1/operations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: randomUUID(), at: Date.now(), ...body }),
  })
}

test('#260 RT-1 a write through the API reaches a WebSocket subscriber as a change without a payload', async () => {
  const { config, seed } = requireSetup()
  const sam = demoUser('starter')
  const okafor = demoUser('advisor')
  const slug = seed.flow?.slug
  if (slug === undefined) throw new Error('the seed has no flow')
  const samToken = await passwordToken(config, sam.email, sam.password)
  const okaforToken = await passwordToken(config, okafor.email, okafor.password)

  const instanceId = randomUUID()
  const started = await post(samToken, {
    type: 'instance.started@1',
    actor: sam.id,
    payload: { flow: slug, instanceId, values: { summary: 'realtime', credits: 2 } },
  })
  expect(started.status, await started.clone().text()).toBe(201)

  const sam1 = await connect(samToken)
  sam1.ws.send(JSON.stringify({ type: 'hello', protocol: 1 }))
  const welcome = await sam1.next()
  expect(welcome).toMatchObject({ type: 'welcome', protocol: 1, principal: { id: sam.id } })
  sam1.ws.send(JSON.stringify({ type: 'subscribe', instance: instanceId }))
  expect(await sam1.next()).toMatchObject({ type: 'subscribed', instance: instanceId })

  // Okafor may not read Sam's draft (ADR 0014, I8): refused on the channel.
  const stranger = await connect(okaforToken)
  stranger.ws.send(JSON.stringify({ type: 'hello', protocol: 1 }))
  await stranger.next()
  stranger.ws.send(JSON.stringify({ type: 'subscribe', instance: instanceId }))
  expect(await stranger.next()).toMatchObject({ type: 'refused', instance: instanceId })
  stranger.ws.close()

  // The submit lands through the API; the change reaches Sam through the
  // log channel, with the seq and the type and nothing else.
  const submitted = await post(samToken, {
    type: 'instance.submitted@1',
    actor: sam.id,
    payload: { instanceId, version: 0, values: {} },
  })
  expect(submitted.status, await submitted.clone().text()).toBe(201)
  const event = (await submitted.json()) as { seq: number }
  const changed = await sam1.next()
  expect(changed).toEqual({
    type: 'changed',
    seq: event.seq,
    eventType: 'instance.submitted@1',
    instance: instanceId,
  })

  // Presence: a second session of Sam on the same instance shows two people.
  sam1.ws.send(JSON.stringify({ type: 'presence', instance: instanceId, where: 'summary' }))
  expect((await sam1.next()).people).toEqual([
    { id: sam.id, displayName: expect.any(String), where: 'summary' },
  ])
  const sam2 = await connect(samToken)
  sam2.ws.send(JSON.stringify({ type: 'hello', protocol: 1 }))
  await sam2.next()
  sam2.ws.send(JSON.stringify({ type: 'subscribe', instance: instanceId }))
  await sam2.next()
  sam2.ws.send(JSON.stringify({ type: 'presence', instance: instanceId }))
  expect(((await sam2.next()).people as unknown[]).length).toBe(2)
  expect(((await sam1.next()).people as unknown[]).length).toBe(2)
  sam2.ws.close()
  sam1.ws.close()

  // The polling fallback reads the same event after the welcome position (RT-1).
  const polled = await fetch(
    `${requireSetup().publicUrl}/api/v1/log?instance=${instanceId}&after=${String(welcome.seq)}`,
    { headers: { authorization: `Bearer ${samToken}` } }
  )
  expect(polled.status).toBe(200)
  const events = (await polled.json()) as { seq: number; type: string }[]
  expect(events.map((entry) => entry.type)).toEqual(['instance.submitted@1'])

  // The Server-Sent Events fallback opens for Sam and not for Lee, whose
  // registrar step the instance has not reached (I8).
  const stream = await fetch(
    `${requireSetup().publicUrl}/api/v1/realtime/events?instance=${instanceId}`,
    { headers: { authorization: `Bearer ${samToken}` } }
  )
  expect(stream.status).toBe(200)
  const reader = stream.body?.getReader()
  if (reader === undefined) throw new Error('no stream')
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('event: welcome')
  await reader.cancel()
  const lee = demoUser('registrar', 1)
  const leeToken = await passwordToken(config, lee.email, lee.password)
  const refused = await fetch(
    `${requireSetup().publicUrl}/api/v1/realtime/events?instance=${instanceId}`,
    { headers: { authorization: `Bearer ${leeToken}` } }
  )
  expect(refused.status).toBe(403)
})
