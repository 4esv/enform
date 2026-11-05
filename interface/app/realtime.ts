// Issue #260, RT-1, RT-2, DX-2, A4, ADR 0006: the realtime transport of the
// interface. The ladder is WebSocket, then Server-Sent Events, then polling,
// then offline, and the mode is always reported, so the page shows it. The
// server notifies and the page reads (I8): a change names the seq and the
// scope of a new event, and the page re-reads through the API. Presence
// travels over the WebSocket only; the fallbacks are one-way, so a page on
// them shows nobody rather than a stale list (A4). Every constructor is
// injected, so the ladder runs in a test without a browser (I6).

import { readLog, realtimeUrl, streamEventsUrl } from '../client/client.js'

/** The transport mode the page shows (RT-1). */
export type Mode = 'live' | 'degraded' | 'polling' | 'offline'

/** The protocol version this interface speaks (DX-2). */
export const PROTOCOL = 1

/** What a subscription names: one instance or one flow. */
export type Scope = { readonly instance: string } | { readonly flow: string }

/** A change notification (schemas/realtime/v1.json). */
export type Changed = {
  readonly seq: number
  readonly eventType: string
  readonly instance?: string
  readonly flow?: string
}

/** One person present on the scope (RT-2). */
export type Present = { readonly id: string; readonly displayName: string; readonly where?: string }

/** A minimal WebSocket, as the browser and a test double provide it. */
export type SocketLike = {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** A minimal EventSource, as the browser and a test double provide it. */
export type SourceLike = {
  close(): void
  onopen: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  addEventListener(type: string, listener: (event: { readonly data: unknown }) => void): void
}

export type RealtimeOptions = {
  readonly scope: Scope
  /** The log position the page read, so polling starts after it. */
  readonly seq: number
  readonly onMode: (mode: Mode) => void
  readonly onChanged: (change: Changed) => void
  readonly onPresence?: (people: readonly Present[]) => void
  /** The server no longer speaks this interface's protocol: reload the page (MVP.md 9.3). */
  readonly onReload?: (supported: readonly number[]) => void
  /** The constructors and the clock, injected (I6). */
  readonly sockets?: (url: string) => SocketLike
  readonly sources?: (url: string) => SourceLike
  /** The log read of the polling rung; the default is the generated client's. */
  readonly readLog?: (
    scope: Scope,
    after: number
  ) => Promise<readonly { readonly seq: number; readonly type: string }[]>
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  /** The polling interval in milliseconds; the default is five seconds. */
  readonly pollMs?: number
  /** How long to wait for a transport to open before falling back, in milliseconds. */
  readonly openMs?: number
}

export type Realtime = {
  readonly mode: () => Mode
  /** Say where the person is on the scope (RT-2); only the live transport carries it. */
  readonly presence: (where?: string) => void
  readonly close: () => void
}

const OPEN = 1

/** Open the transport ladder for one scope. */
export function openRealtime(options: RealtimeOptions): Realtime {
  const sockets = options.sockets ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
  const sources =
    options.sources ?? ((url: string) => new EventSource(url) as unknown as SourceLike)
  const readAfter =
    options.readLog ??
    ((scope: Scope, after: number) =>
      readLog(
        'instance' in scope ? scope.instance : undefined,
        undefined,
        after,
        'flow' in scope ? scope.flow : undefined
      ))
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number))
  const pollMs = options.pollMs ?? 5_000
  const openMs = options.openMs ?? 4_000

  let mode: Mode = 'offline'
  let closed = false
  let seq = options.seq
  // A page that knows no log position starts from 0: the first read then
  // sets the baseline silently, so the page does not replay its own history.
  let baselined = seq > 0
  let socket: SocketLike | undefined
  let source: SourceLike | undefined
  let timer: unknown
  let where: string | undefined

  const setMode = (next: Mode): void => {
    if (mode === next) return
    mode = next
    options.onMode(next)
  }

  const changed = (message: Record<string, unknown>): void => {
    const at = message.seq
    if (typeof at !== 'number' || typeof message.eventType !== 'string') return
    if (at > seq) seq = at
    options.onChanged({
      seq: at,
      eventType: message.eventType,
      ...(typeof message.instance === 'string' ? { instance: message.instance } : {}),
      ...(typeof message.flow === 'string' ? { flow: message.flow } : {}),
    })
  }

  const presence = (message: Record<string, unknown>): void => {
    if (Array.isArray(message.people)) options.onPresence?.(message.people as Present[])
  }

  const handle = (raw: unknown): void => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>
    } catch {
      return
    }
    if (message.type === 'changed') changed(message)
    else if (message.type === 'presence') presence(message)
    else if (message.type === 'reload') {
      const supported = Array.isArray(message.supported) ? (message.supported as number[]) : []
      options.onReload?.(supported)
    }
  }

  // The polling fallback reads the log after the last position it saw (I4),
  // and derives each change itself; a failed read means offline, and the
  // next read that lands brings polling back (A4).
  const poll = async (): Promise<void> => {
    if (closed) return
    try {
      const events = await readAfter(options.scope, seq)
      setMode('polling')
      if (!baselined) {
        baselined = true
        for (const event of events) if (event.seq > seq) seq = event.seq
      } else
        for (const event of events) {
          changed({
            type: 'changed',
            seq: event.seq,
            eventType: event.type,
            ...('instance' in options.scope ? { instance: options.scope.instance } : {}),
            ...('flow' in options.scope ? { flow: options.scope.flow } : {}),
          })
        }
    } catch {
      setMode('offline')
    }
    if (!closed) timer = setTimer(() => void poll(), pollMs)
  }

  const startPolling = (): void => {
    options.onPresence?.([])
    void poll()
  }

  // The second rung: Server-Sent Events, one way, with the same messages.
  const startSource = (): void => {
    let opened = false
    const url = streamEventsUrl(
      'instance' in options.scope ? options.scope.instance : undefined,
      'flow' in options.scope ? options.scope.flow : undefined
    )
    let stream: SourceLike
    try {
      stream = sources(url)
    } catch {
      startPolling()
      return
    }
    source = stream
    const giveUp = (): void => {
      if (closed) return
      stream.close()
      source = undefined
      options.onPresence?.([])
      startPolling()
    }
    const guard = setTimer(() => {
      if (!opened) giveUp()
    }, openMs)
    stream.onopen = () => {
      opened = true
      clearTimer(guard)
      setMode('degraded')
    }
    stream.onerror = () => {
      clearTimer(guard)
      giveUp()
    }
    for (const type of ['changed', 'presence', 'reload']) {
      stream.addEventListener(type, (event) => handle(event.data))
    }
  }

  // The first rung: the WebSocket, with the handshake and the subscription.
  const startSocket = (): void => {
    let welcomed = false
    const url = realtimeUrl().replace(/^http/, 'ws')
    let ws: SocketLike
    try {
      ws = sockets(url)
    } catch {
      startSource()
      return
    }
    socket = ws
    const fallBack = (): void => {
      if (closed) return
      socket = undefined
      if (welcomed) {
        // A live channel that dropped: try the ladder from the top again
        // after the polling interval, and poll meanwhile.
        setMode('polling')
        startPolling()
        return
      }
      startSource()
    }
    const guard = setTimer(() => {
      if (!welcomed) {
        ws.close()
        fallBack()
      }
    }, openMs)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL }))
    ws.onmessage = (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (message.type === 'welcome') {
        welcomed = true
        clearTimer(guard)
        if (typeof message.seq === 'number' && message.seq > seq) seq = message.seq
        baselined = true
        ws.send(JSON.stringify({ type: 'subscribe', ...options.scope }))
        return
      }
      if (message.type === 'subscribed') {
        setMode('live')
        if (where !== undefined || options.onPresence !== undefined) {
          ws.send(
            JSON.stringify({
              type: 'presence',
              ...options.scope,
              ...(where === undefined ? {} : { where }),
            })
          )
        }
        return
      }
      if (message.type === 'refused' && !welcomed) {
        clearTimer(guard)
        ws.close()
        return
      }
      handle(event.data)
    }
    ws.onerror = () => {
      clearTimer(guard)
    }
    ws.onclose = () => {
      clearTimer(guard)
      fallBack()
    }
  }

  startSocket()

  return {
    mode: () => mode,
    presence: (next) => {
      where = next
      const ws = socket
      if (ws !== undefined && ws.readyState === OPEN && mode === 'live') {
        ws.send(
          JSON.stringify({
            type: 'presence',
            ...options.scope,
            ...(next === undefined ? {} : { where: next }),
          })
        )
      }
    },
    close: () => {
      closed = true
      if (timer !== undefined) clearTimer(timer)
      socket?.close()
      source?.close()
    },
  }
}

/** The label of a mode, as the indicator shows it (RT-1, A4). */
export function modeLabel(mode: Mode): string {
  switch (mode) {
    case 'live':
      return 'Live'
    case 'degraded':
      return 'Degraded: updates arrive, presence does not'
    case 'polling':
      return 'Polling'
    case 'offline':
      return 'Offline'
  }
}
