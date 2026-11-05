import { createServer, type Server } from 'node:http'
import type { Pool } from 'pg'
import { afterAll, beforeAll, expect, test } from 'vitest'
import WebSocket from 'ws'
import { defaultConfig } from './config.js'

// Issue #260, RT-1, RT-2, DX-2, I8, ADR 0006: the realtime channel of the
// server. A WebSocket client sends `hello` with its protocol version and gets
// `welcome` with the principal and the log position, or `reload` when the
// server does not speak that version. A subscription is authorized when it
// is opened: a flow the person may read answers `subscribed`, an instance the
// log does not hold answers `refused`. A new event that touches a subscribed
// flow arrives as `changed` without a payload, and presence names who is on
// the flow and where. The Server-Sent Events fallback sends `welcome` and
// `changed` one way. The checks run against the real HTTP application over a
// pool that answers one cookie session, as the auth checks do.

type Realtime = {
  createHub: () => {
    publish: (event: { seq: number; type: string; payload: Record<string, unknown> }) => void
    connections: () => number
  }
  attachRealtime: (server: Server, hub: unknown) => void
  createApp: (
    config: unknown,
    pool: Pool,
    hub?: unknown
  ) => { fetch: (request: Request) => Promise<Response> }
}

/** The modules under test, resolved at run time: the file type-checks while the realtime module is absent (#260). */
const REALTIME_MODULE = new URL('./realtime.js', import.meta.url).href
const HTTP_MODULE = new URL('./http.js', import.meta.url).href

async function modules(): Promise<Realtime> {
  const realtime = (await import(REALTIME_MODULE)) as Record<string, unknown>
  const http = (await import(HTTP_MODULE)) as Record<string, unknown>
  return { ...realtime, ...http } as unknown as Realtime
}

/**
 * A pool that answers one valid cookie session (as http.test.ts does) and a
 * log that holds one grant event per given grant, because the reads
 * authorize against the grants the log records (I4, I8).
 */
function sessionPool(grants: readonly Record<string, unknown>[] = []): Pool {
  const now = Date.now()
  const events = grants.map((grant, index) => ({
    seq: String(index + 1),
    operation_id: `grant-${index + 1}`,
    type: 'config.grant.changed@1',
    at: String(index + 1),
    actor: 'user:dana',
    payload: grant,
  }))
  return {
    query: (text: string) => {
      if (text.includes('from events')) return Promise.resolve({ rows: events })
      if (text.includes('from sessions')) {
        return Promise.resolve({
          rows: [
            {
              id: 'session-1',
              principal_id: 'user-1',
              csrf_token: 'csrf-1',
              created_at: String(now),
              expires_at: String(now + 3_600_000),
              last_seen_at: String(now),
              revoked_at: null,
              refresh_token: null,
            },
          ],
        })
      }
      if (text.includes('from principals')) {
        return Promise.resolve({
          rows: [{ id: 'user-1', display_name: 'Ana', email: null, groups: [] }],
        })
      }
      if (text.includes('from grants')) return Promise.resolve({ rows: grants })
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Pool
}

const cookie = `${defaultConfig.session.cookieName}=session-1`
const flowGrant = { principal: 'user-1', scopes: ['flow.read'], resource: 'flow:course-overload' }

let server: Server | undefined
let base = ''
let hub: ReturnType<Realtime['createHub']>
let setupError: unknown

/** The hub of the running server, or the reason the setup failed. */
function requireHub(): ReturnType<Realtime['createHub']> {
  if (setupError !== undefined) throw setupError
  return hub
}

beforeAll(async () => {
  try {
    await start()
  } catch (error) {
    setupError = error
  }
})

async function start(): Promise<void> {
  const { createHub, createApp, attachRealtime } = await modules()
  hub = createHub()
  const pool = sessionPool([flowGrant])
  const app = createApp(defaultConfig, pool, hub)
  server = createServer((req, res) => {
    // Bridge Node's request to the fetch handler of the application.
    const url = `http://127.0.0.1${req.url ?? '/'}`
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const response = await app.fetch(
        new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
        })
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body === null) return res.end()
      const reader = response.body.getReader()
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read()
        if (done) {
          res.end()
          return
        }
        res.write(value)
        return pump()
      }
      await pump()
    })
  })
  const listening = server
  attachRealtime(listening, hub)
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(listening.address() as { port: number }).port}`
}

afterAll(async () => {
  const listening = server
  if (listening === undefined) return
  await new Promise<void>((resolve) => listening.close(() => resolve()))
})

/** A WebSocket client with the session cookie, and a queue of the messages it received. */
function connect(): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/api/v1/realtime`, { headers: { cookie } })
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
          new Promise((answer) => {
            const queued = queue.shift()
            if (queued !== undefined) answer(queued)
            else waiting.push(answer)
          }),
      })
    )
    ws.on('error', (error) => reject(new Error(`the socket did not open: ${error.message}`)))
  })
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}

test('#260 DX-2 the handshake answers welcome for a supported version and reload for another', async () => {
  requireHub()
  const { ws, next } = await connect()
  send(ws, { type: 'hello', protocol: 1 })
  expect(await next()).toEqual({
    type: 'welcome',
    protocol: 1,
    principal: { id: 'user-1', displayName: 'Ana' },
    seq: 1,
  })
  ws.close()

  const old = await connect()
  send(old.ws, { type: 'hello', protocol: 99 })
  expect(await old.next()).toMatchObject({ type: 'reload', supported: [1] })
  await new Promise<void>((resolve) => old.ws.on('close', () => resolve()))
})

test('#260 I8 a subscription is authorized when it is opened, a change arrives without a payload, and presence names who is where', async () => {
  const hub = requireHub()
  const ana = await connect()
  send(ana.ws, { type: 'hello', protocol: 1 })
  await ana.next()
  // The log holds no instance inst-1: refused (I8).
  send(ana.ws, { type: 'subscribe', instance: 'inst-1' })
  expect(await ana.next()).toMatchObject({ type: 'refused', instance: 'inst-1' })
  // Ana holds flow.read on course-overload: subscribed, and her presence is
  // broadcast to the flow's subscribers, herself included.
  send(ana.ws, { type: 'subscribe', flow: 'course-overload' })
  expect(await ana.next()).toEqual({ type: 'subscribed', flow: 'course-overload', seq: 1 })
  send(ana.ws, { type: 'presence', flow: 'course-overload', where: '/steps/request' })
  expect(await ana.next()).toEqual({
    type: 'presence',
    flow: 'course-overload',
    people: [{ id: 'user-1', displayName: 'Ana', where: '/steps/request' }],
  })
  // A second viewer of the same flow sees Ana, and Ana sees the newcomer.
  const other = await connect()
  send(other.ws, { type: 'hello', protocol: 1 })
  await other.next()
  send(other.ws, { type: 'subscribe', flow: 'course-overload' })
  await other.next()
  send(other.ws, { type: 'presence', flow: 'course-overload' })
  const seen = await other.next()
  expect((seen.people as unknown[]).length).toBe(2)
  const update = await ana.next()
  expect((update.people as unknown[]).length).toBe(2)
  // A new event on the flow reaches both as a change with the seq and the
  // type, and nothing else (I8); an event of another flow reaches nobody.
  hub.publish({
    seq: 7,
    type: 'config.definition.published@1',
    payload: { slug: 'course-overload', version: 2 },
  })
  hub.publish({ seq: 8, type: 'config.definition.changed@1', payload: { flow: 'other-flow' } })
  expect(await ana.next()).toEqual({
    type: 'changed',
    seq: 7,
    eventType: 'config.definition.published@1',
    flow: 'course-overload',
  })
  expect(await other.next()).toMatchObject({ type: 'changed', seq: 7 })
  // When the newcomer leaves, Ana is alone again.
  other.ws.close()
  const alone = await ana.next()
  expect(alone).toMatchObject({ type: 'presence', flow: 'course-overload' })
  expect((alone.people as { id: string }[]).map((person) => person.id)).toEqual(['user-1'])
  ana.ws.close()
  // A ping answers a pong, and an unknown message is refused rather than closed.
  const ping = await connect()
  send(ping.ws, { type: 'hello', protocol: 1 })
  await ping.next()
  send(ping.ws, { type: 'ping' })
  expect(await ping.next()).toEqual({ type: 'pong' })
  send(ping.ws, { type: 'cursor' })
  expect(await ping.next()).toMatchObject({ type: 'refused' })
  ping.ws.close()
})

test('#260 RT-1 the Server-Sent Events fallback sends welcome and the changes of one scope', async () => {
  const hub = requireHub()
  const response = await fetch(`http://${base}/api/v1/realtime/events?flow=course-overload`, {
    headers: { cookie },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('no stream')
  const decoder = new TextDecoder()
  let text = ''
  const until = async (needle: string): Promise<void> => {
    while (!text.includes(needle)) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`the stream ended before ${needle}`)
      text += decoder.decode(value)
    }
  }
  await until('event: welcome')
  hub.publish({ seq: 9, type: 'config.flow.title@1', payload: { flow: 'course-overload' } })
  await until('event: changed')
  expect(text).toContain('"seq":9')
  expect(text).not.toContain('"payload"')
  await reader.cancel()
  // Without a session the stream is refused, and an unreadable flow too (I8).
  expect((await fetch(`http://${base}/api/v1/realtime/events?flow=course-overload`)).status).toBe(
    401
  )
  expect(
    (await fetch(`http://${base}/api/v1/realtime/events?flow=secret`, { headers: { cookie } }))
      .status
  ).toBe(403)
})
