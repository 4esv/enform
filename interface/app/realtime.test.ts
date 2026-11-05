import { expect, test } from 'vitest'
import { setClient } from '../client/client.js'
import { openRealtime, type SocketLike, type SourceLike } from './realtime.js'

// Issue #260, RT-1, RT-2, A4, ADR 0006: the transport ladder of the
// interface. The WebSocket is the first rung: the handshake, the
// subscription, the changes and presence. When it does not open, the page
// falls to Server-Sent Events, then to polling, then to offline, and it
// reports every mode it is in. The doubles stand in for the browser's
// constructors, so the ladder runs without a browser (I6).

// The URL builders of the generated client need a base URL (DX-4).
setClient({ baseUrl: 'http://127.0.0.1:1', token: '' })

/** A WebSocket double the test drives. */
function socketDouble(): SocketLike & {
  sent: string[]
  open: () => void
  receive: (message: Record<string, unknown>) => void
  drop: () => void
} {
  const double = {
    readyState: 0,
    sent: [] as string[],
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { readonly data: unknown }) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    send(data: string) {
      double.sent.push(data)
    },
    close() {
      double.readyState = 3
      double.onclose?.({})
    },
    open() {
      double.readyState = 1
      double.onopen?.({})
    },
    receive(message: Record<string, unknown>) {
      double.onmessage?.({ data: JSON.stringify(message) })
    },
    drop() {
      double.readyState = 3
      double.onclose?.({})
    },
  }
  return double
}

/** Timers the test fires by hand. */
function timers(): {
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  fire: () => void
} {
  const pending = new Map<number, () => void>()
  let next = 0
  return {
    setTimer: (callback) => {
      next += 1
      pending.set(next, callback)
      return next
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
    fire: () => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
  }
}

test('#260 RT-1 the WebSocket rung handshakes, subscribes, relays changes and presence, and polls when it drops', async () => {
  const modes: string[] = []
  const changes: number[] = []
  const people: string[][] = []
  const socket = socketDouble()
  const clock = timers()
  const polled: string[] = []
  const realtime = openRealtime({
    scope: { instance: 'inst-1' },
    seq: 3,
    onMode: (mode) => modes.push(mode),
    onChanged: (change) => changes.push(change.seq),
    onPresence: (present) => people.push(present.map((person) => person.id)),
    sockets: () => socket,
    sources: () => {
      throw new Error('no SSE in this test')
    },
    readLog: async (scope, after) => {
      polled.push(`${JSON.stringify(scope)} after=${after}`)
      return [{ seq: 9, type: 'step.claimed@1' }]
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  socket.open()
  expect(JSON.parse(socket.sent[0])).toEqual({ type: 'hello', protocol: 1 })
  socket.receive({ type: 'welcome', protocol: 1, principal: { id: 'u', displayName: 'U' }, seq: 5 })
  expect(JSON.parse(socket.sent[1])).toEqual({ type: 'subscribe', instance: 'inst-1' })
  socket.receive({ type: 'subscribed', instance: 'inst-1', seq: 5 })
  expect(realtime.mode()).toBe('live')
  expect(modes).toEqual(['live'])
  // The page says where it is, and the server answers who is there (RT-2).
  realtime.presence('summary')
  expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
    type: 'presence',
    instance: 'inst-1',
    where: 'summary',
  })
  socket.receive({ type: 'presence', instance: 'inst-1', people: [{ id: 'u', displayName: 'U' }] })
  expect(people.at(-1)).toEqual(['u'])
  // A change relays the seq and the type, never a payload (I8).
  socket.receive({ type: 'changed', seq: 6, eventType: 'step.claimed@1', instance: 'inst-1' })
  expect(changes).toEqual([6])
  // The live channel drops: the page polls the log after the last seq it
  // saw and says so; presence is cleared rather than left stale (A4).
  socket.drop()
  await Promise.resolve()
  await Promise.resolve()
  expect(modes).toEqual(['live', 'polling'])
  expect(people.at(-1)).toEqual([])
  expect(polled[0]).toBe('{"instance":"inst-1"} after=6')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(changes).toEqual([6, 9])
  realtime.close()
})

test('#260 RT-1 when the WebSocket does not open the page falls to Server-Sent Events, then to polling, then to offline', async () => {
  const modes: string[] = []
  const clock = timers()
  let fetches = 0
  const source: SourceLike & { listeners: Map<string, (event: { data: unknown }) => void> } = {
    listeners: new Map(),
    onopen: null,
    onerror: null,
    close() {},
    addEventListener(type, listener) {
      this.listeners.set(type, listener)
    },
  }
  const realtime = openRealtime({
    scope: { flow: 'course-overload' },
    seq: 0,
    onMode: (mode) => modes.push(mode),
    onChanged: () => {},
    sockets: () => {
      throw new Error('WebSocket is blocked')
    },
    sources: () => source,
    readLog: async () => {
      fetches += 1
      throw new Error('network down')
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  // The stream opens: degraded, with updates and no presence.
  source.onopen?.({})
  expect(realtime.mode()).toBe('degraded')
  // The stream fails: polling, and the network is down: offline.
  source.onerror?.({})
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetches).toBe(1)
  expect(modes).toEqual(['degraded', 'offline'])
  // The next poll is scheduled; closing cancels it.
  realtime.close()
  clock.fire()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(fetches).toBe(1)
})

test('#260 DX-2 a reload answer reaches the page, so it can load a newer interface', () => {
  const socket = socketDouble()
  const clock = timers()
  let supported: readonly number[] = []
  openRealtime({
    scope: { instance: 'inst-1' },
    seq: 0,
    onMode: () => {},
    onChanged: () => {},
    onReload: (versions) => {
      supported = versions
    },
    sockets: () => socket,
    sources: () => {
      throw new Error('unused')
    },
    readLog: async () => [],
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  socket.open()
  socket.receive({ type: 'reload', supported: [2], reason: 'the server speaks protocol version 2' })
  expect(supported).toEqual([2])
})
