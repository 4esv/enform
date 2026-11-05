import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Pool } from 'pg'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Event } from '../engine/operation.js'
import { flowOf } from '../engine/timeline.js'
import { LOG_CHANNEL, readEventsAfter } from './db.js'

// Issue #260, RT-1, RT-2, DX-2, I8, ADR 0006: the realtime channel. The
// server notifies and the client reads: a `changed` message names the seq,
// the type and the instance or the flow of a new event, never its payload,
// so every read stays on the authorized HTTP API. A subscription is
// authorized when it is opened, through the same reads the API uses. The
// hub is one in-memory registry per process; the log is the bus between
// processes: every append notifies `enform_log` through PostgreSQL, and
// each process reads the events after the last seq it published. The
// protocol is `schemas/realtime/v1.json`; the server speaks the current
// version and the previous one and tells an older client to reload.

/** The protocol versions this server speaks (MVP.md 9.3): the current one and the previous one. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1]

/** What a subscription or a presence names: one instance or one flow. */
export type Scope = { readonly instance: string } | { readonly flow: string }

/** One person on the channel (ID-4): the id and the name the messages show, and the groups the reads authorize with. */
export type Person = {
  readonly id: string
  readonly displayName: string
  readonly groups: readonly string[]
}

/** The person as a message shows it (DX-2): the id and the display name, nothing else. */
function shown(person: Person): { readonly id: string; readonly displayName: string } {
  return { id: person.id, displayName: person.displayName }
}

/** What the hub needs from the server (I8): who a connection is, and what it may read. */
export type HubDeps = {
  readonly authenticate: (headers: Headers) => Promise<Person | undefined>
  /** `ok` when the person may read the scope, `missing` when the log does not hold it, `refused` otherwise. */
  readonly authorize: (person: Person, scope: Scope) => Promise<'ok' | 'missing' | 'refused'>
  /** The current log position (I4). */
  readonly head: () => Promise<number>
}

/** One message the server sends (schemas/realtime/v1.json). */
export type ServerMessage = Record<string, unknown> & { readonly type: string }

/** One listener of a scope: an SSE stream or a WebSocket connection. */
type Listener = (message: ServerMessage) => void

/** One connection's presence on a scope. */
type Presence = { readonly person: Person; readonly where?: string }

/** One person as presence shows it (RT-2). */
type Shown = { readonly id: string; readonly displayName: string; readonly where?: string }

/** The key of a scope in the registries. */
function keyOf(scope: Scope): string {
  return 'instance' in scope ? `instance:${scope.instance}` : `flow:${scope.flow}`
}

/** The scope object of a message that names one, or undefined (DX-2). */
function scopeOf(message: Record<string, unknown>): Scope | undefined {
  const instance = message.instance
  const flow = message.flow
  if (typeof instance === 'string' && instance !== '' && flow === undefined) return { instance }
  if (typeof flow === 'string' && flow !== '' && instance === undefined) return { flow }
  return undefined
}

/** The scopes an event touches: its instance, and its flow (VT-5, VT-6). */
export function scopesOfEvent(event: Pick<Event, 'type' | 'payload'>): readonly Scope[] {
  const scopes: Scope[] = []
  const instance = event.payload.instanceId
  if (typeof instance === 'string') scopes.push({ instance })
  const flow = flowOf(event as Event)
  if (flow !== undefined) scopes.push({ flow })
  return scopes
}

/** The change notification of one event (DX-2): the seq, the type and the scope, no payload (I8). */
function changedMessage(
  event: Pick<Event, 'seq' | 'type' | 'payload'>,
  scope: Scope
): ServerMessage {
  return { type: 'changed', seq: event.seq, eventType: event.type, ...scope }
}

export type Hub = {
  /** Give the hub the server's authentication and authorization (I8). */
  readonly configure: (deps: HubDeps) => void
  /** Publish one new event of the log to the subscribers of its scopes. */
  readonly publish: (event: Pick<Event, 'seq' | 'type' | 'payload'>) => void
  /** Listen to one scope (the SSE fallback); the answer unsubscribes. */
  readonly subscribe: (scope: Scope, listener: Listener) => () => void
  /** Serve one WebSocket connection of a signed-in person. */
  readonly connect: (socket: WebSocket, person: Person) => void
  /** How many WebSocket connections are open. */
  readonly connections: () => number
  /** Who is on a scope now (RT-2). */
  readonly presenceOf: (scope: Scope) => readonly Shown[]
  /** The server's dependencies, once configured. */
  readonly deps: () => HubDeps
}

/** One in-memory hub per process. */
export function createHub(): Hub {
  let deps: HubDeps | undefined
  const listeners = new Map<string, Set<Listener>>()
  const presence = new Map<string, Map<object, Presence>>()
  let open = 0

  const required = (): HubDeps => {
    if (deps === undefined) throw new Error('realtime: the hub is not configured')
    return deps
  }

  const subscribe = (scope: Scope, listener: Listener): (() => void) => {
    const key = keyOf(scope)
    const set = listeners.get(key) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(key, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  }

  const broadcast = (scope: Scope, message: ServerMessage): void => {
    for (const listener of listeners.get(keyOf(scope)) ?? []) listener(message)
  }

  const presenceOf = (scope: Scope): readonly Shown[] =>
    [...(presence.get(keyOf(scope))?.values() ?? [])].map((entry) => ({
      ...shown(entry.person),
      ...(entry.where === undefined ? {} : { where: entry.where }),
    }))

  const presenceMessage = (scope: Scope): ServerMessage => ({
    type: 'presence',
    ...scope,
    people: presenceOf(scope),
  })

  const setPresence = (owner: object, scope: Scope, entry: Presence | undefined): void => {
    const key = keyOf(scope)
    const map = presence.get(key) ?? new Map<object, Presence>()
    if (entry === undefined) map.delete(owner)
    else map.set(owner, entry)
    if (map.size === 0) presence.delete(key)
    else presence.set(key, map)
    broadcast(scope, presenceMessage(scope))
  }

  const publish = (event: Pick<Event, 'seq' | 'type' | 'payload'>): void => {
    for (const scope of scopesOfEvent(event)) broadcast(scope, changedMessage(event, scope))
  }

  const connect = (socket: WebSocket, person: Person): void => {
    open += 1
    const owner = {}
    const subscriptions = new Map<string, { scope: Scope; off: () => void }>()
    let greeted = false
    const send = (message: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const refuse = (reason: string, scope?: Scope): void =>
      send({ type: 'refused', ...(scope ?? {}), reason })
    const leave = (): void => {
      for (const { scope, off } of subscriptions.values()) {
        off()
        if (presence.get(keyOf(scope))?.has(owner)) setPresence(owner, scope, undefined)
      }
      subscriptions.clear()
    }
    socket.on('close', () => {
      open -= 1
      leave()
    })
    socket.on('error', () => socket.close())
    socket.on('message', async (raw) => {
      let message: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(String(raw))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error()
        message = parsed as Record<string, unknown>
      } catch {
        refuse('the message is not a JSON object')
        return
      }
      try {
        if (message.type === 'hello') {
          const protocol = message.protocol
          if (typeof protocol !== 'number' || !SUPPORTED_PROTOCOLS.includes(protocol)) {
            send({
              type: 'reload',
              supported: [...SUPPORTED_PROTOCOLS],
              reason: `the server speaks protocol version${SUPPORTED_PROTOCOLS.length === 1 ? '' : 's'} ${SUPPORTED_PROTOCOLS.join(', ')}`,
            })
            socket.close(1002, 'unsupported protocol version')
            return
          }
          greeted = true
          send({
            type: 'welcome',
            protocol,
            principal: shown(person),
            seq: await required().head(),
          })
          return
        }
        if (!greeted) {
          refuse('send hello first')
          return
        }
        if (message.type === 'ping') {
          send({ type: 'pong' })
          return
        }
        if (message.type === 'subscribe' || message.type === 'unsubscribe') {
          const scope = scopeOf(message)
          if (scope === undefined) {
            refuse('a subscription names one instance or one flow')
            return
          }
          const key = keyOf(scope)
          if (message.type === 'unsubscribe') {
            const held = subscriptions.get(key)
            if (held !== undefined) {
              held.off()
              subscriptions.delete(key)
              if (presence.get(key)?.has(owner)) setPresence(owner, scope, undefined)
            }
            return
          }
          const decision = await required().authorize(person, scope)
          if (decision !== 'ok') {
            refuse(decision === 'missing' ? 'not found' : 'not readable', scope)
            return
          }
          if (!subscriptions.has(key))
            subscriptions.set(key, { scope, off: subscribe(scope, send) })
          send({ type: 'subscribed', ...scope, seq: await required().head() })
          return
        }
        if (message.type === 'presence') {
          const scope = scopeOf(message)
          if (scope === undefined) {
            refuse('a presence names one instance or one flow')
            return
          }
          if (!subscriptions.has(keyOf(scope))) {
            refuse('subscribe before you say where you are', scope)
            return
          }
          const where = typeof message.where === 'string' ? message.where : undefined
          setPresence(owner, scope, { person, ...(where === undefined ? {} : { where }) })
          return
        }
        refuse(`unknown message type ${String(message.type)}`)
      } catch (error) {
        refuse(error instanceof Error ? error.message : String(error))
      }
    })
  }

  return {
    configure: (next) => {
      deps = next
    },
    publish,
    subscribe,
    connect,
    connections: () => open,
    presenceOf,
    deps: required,
  }
}

/** The path of the WebSocket channel (RT-1). */
export const REALTIME_PATH = '/api/v1/realtime'

/**
 * Serve the WebSocket channel on a Node server: an upgrade of the realtime
 * path is authenticated with the same headers as a request (the session
 * cookie, or a bearer token), and refused with 401 without a session.
 */
export function attachRealtime(server: Server, hub: Hub): void {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? '').split('?')[0]
    if (path !== REALTIME_PATH) {
      socket.destroy()
      return
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value)
      else if (Array.isArray(value)) headers.set(name, value.join(', '))
    }
    let person: Person | undefined
    try {
      person = await hub.deps().authenticate(headers)
    } catch {
      person = undefined
    }
    if (person === undefined) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const who = person
    wss.handleUpgrade(request, socket, head, (ws) => hub.connect(ws, who))
  })
}

/**
 * Follow the log across processes (ADR 0003): every append notifies the log
 * channel, and this process publishes each event after the last seq it saw,
 * so a write by another process or by the worker reaches the subscribers of
 * this one. The answer stops following.
 */
export async function followLog(hub: Hub, pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect()
  let last = await hub.deps().head()
  let draining: Promise<void> = Promise.resolve()
  const drain = (): Promise<void> => {
    draining = draining.then(async () => {
      const events = await readEventsAfter(pool, last)
      for (const event of events) {
        last = Math.max(last, event.seq)
        hub.publish(event)
      }
    })
    return draining
  }
  client.on('notification', () => {
    void drain()
  })
  await client.query(`listen ${LOG_CHANNEL}`)
  return async () => {
    try {
      await client.query(`unlisten ${LOG_CHANNEL}`)
    } finally {
      client.release()
    }
  }
}
