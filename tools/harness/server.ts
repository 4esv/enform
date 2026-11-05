import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { authorize, type Grant } from '../../engine/authorize.js'
import { publishedByHash, publishedFlow } from '../../engine/flow.js'
import { instanceOf, readInstance } from '../../engine/instances.js'
import type { Operation } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { mayRead } from '../../engine/status.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { flowOf, isConfigChange, timeline, timelineFor } from '../../engine/timeline.js'
import { isClientIntent, resolveClientOperation } from '../../server/intents.js'
import {
  directoryOf,
  grantsApplying,
  groupsOf,
  type Managers,
  type Membership,
} from './directory.js'

// Issue #24, DX-1, MVP.md 9.1: the in-process HTTP API that api/openapi.yaml
// describes. It delegates to the engine (apply, the append-only log). It is
// harness infrastructure, not the release server (deploy/compose.yaml defers
// that image to a later milestone).
//
// Issue #181, FM-1, ADR 0009: it also serves the interface from interface/ so a
// browser can open the app shell. The app is TypeScript and ADR 0009 has no build
// step for it, so the server transpiles a module on the way out: a browser
// does not strip types, and a module specifier names the emitted `.js` file
// that the TypeScript ESM convention writes. The app files are read from disk
// here; the server never imports an interface module. How a release server
// serves the interface is a later issue.

export type Api = {
  server: Server
  state: () => State
  port: () => number
}

/**
 * The injected sources that resolve a client intent (ADR 0010, I6). The
 * directory resolver maps a target to its principals, and the grants are the
 * scopes that apply to the acting principal. A caller that gives none of
 * these reads the grants back from the log, and resolves no target to a
 * member.
 */
export type ApiOptions = {
  /** The grants that apply to the acting principal, pre-filtered (a seam); absent reads the log. */
  readonly grants?: readonly Grant[]
  /**
   * The grants the installation holds before the story (#256): they apply to
   * the principal they name, beside the grants the log records, as the first
   * administrator's grant does on a release server.
   */
  readonly bootstrap?: readonly Grant[]
  /**
   * The directory groups each principal holds (ID-4, ID-5), keyed by principal
   * id; a release server reads them from the session. A principal that the
   * map does not name holds no group here.
   */
  readonly membership?: Membership
  /** The manager of each principal (AS-1, #267), keyed by principal id; a release server reads it from the directory. */
  readonly managers?: Managers
  /** The directory resolver, pre-built (a seam); absent reads the teams from the log and the groups from `membership`. */
  readonly resolve?: TargetResolver
}

/**
 * The directory that holds the interface: the app shell and the generated
 * client. It is served at the site root, because the app imports the client as
 * a sibling of its own directory (ADR 0009, I12).
 */
const INTERFACE_DIR = fileURLToPath(new URL('../../interface/', import.meta.url))

function isOperation(value: unknown): value is Operation {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    typeof o.at === 'number' &&
    (o.actor === undefined || typeof o.actor === 'string') &&
    typeof o.payload === 'object' &&
    o.payload !== null
  )
}

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

/** The content type of an interface asset, or undefined for an unknown extension. */
function assetContentType(path: string): string | undefined {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.ts')) return 'text/javascript; charset=utf-8'
  return undefined
}

/**
 * Resolve one URL path to a file inside interface/, and refuse any path that
 * escapes it or names an extension the interface does not serve (I12, ADR
 * 0009). The app imports the generated client as `../client/client.js` from
 * `/app/app.js`, so the interface directory is served at the site root:
 * `/app/app.js` is `interface/app/app.ts` and `/client/client.js` is
 * `interface/client/client.ts`.
 */
function interfaceAsset(urlPath: string): { file: string; type: string } | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const file = resolve(INTERFACE_DIR, decoded.replace(/^\/+/, ''))
  const rel = relative(INTERFACE_DIR, file)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined
  }
  // A module specifier names the emitted `.js` file (the TypeScript ESM
  // convention). There is no build step (ADR 0009), so the source stands in
  // for its output and the server strips its types below.
  const candidate =
    !existsSync(file) && file.endsWith('.js') ? `${file.slice(0, -'.js'.length)}.ts` : file
  if (!existsSync(candidate)) return undefined
  const type = assetContentType(candidate)
  if (type === undefined) return undefined
  return { file: candidate, type }
}

/**
 * Strip the types from one app module, so a browser receives the JavaScript it
 * runs (#181, ADR 0009). The app is TypeScript, there is no build step, and a
 * browser does not strip types, so the harness server does it here with the
 * same machinery that Node itself uses for a `.ts` file. The app writes only
 * erasable syntax, which is what this mode accepts. It is harness
 * infrastructure and it decides nothing.
 */
function transpileApp(source: string): string {
  return stripTypeScriptTypes(source, { mode: 'strip' })
}

/**
 * The interface file that a GET path names, or undefined when the path is not
 * a page of the interface. The form link is `/app/?slug=<flow>` (S06), so the
 * query string is not part of the path.
 */
function interfacePath(url: string): string | undefined {
  const path = url.split('?')[0]
  if (path === '/' || path === '/app' || path === '/app/') return 'app/index.html'
  // The service worker is served at the root, so its scope covers every page (RT-4, #262).
  if (path === '/sw.js') return 'app/sw.js'
  if (path.startsWith('/app/') || path.startsWith('/client/')) return path.replace(/^\/+/, '')
  return undefined
}

/**
 * Serve one instance read (#76, FM-3, FM-7, DX-1, I8). The actor arrives as the
 * `actor` query parameter, because the harness has no real authentication and
 * the app already carries the principal that way. The engine projects the
 * instance from the log (instanceOf) and authorizes the read (readInstance). An
 * instance the log does not hold answers 404, and an actor that may not read it
 * answers 403 (I8); the route decides neither.
 */
function serveInstanceRead(
  res: ServerResponse,
  url: string,
  state: State,
  options: ApiOptions
): void {
  const parsed = new URL(url, 'http://127.0.0.1')
  const instanceId = decodeURIComponent(parsed.pathname.slice('/api/v1/instances/'.length))
  const actor = parsed.searchParams.get('actor')
  if (actor === null || actor === '') {
    json(res, 400, { error: 'the actor query parameter is required' })
    return
  }
  const instance = instanceOf(state.log, instanceId)
  if (instance === undefined) {
    json(res, 404, { error: 'not found' })
    return
  }
  const published = publishedByHash(state.log, instance.definitionVersion)
  if (published === undefined) {
    json(res, 404, { error: 'not found' })
    return
  }
  const view = readInstance(
    actor,
    instance,
    {
      flow: published.slug,
      definition: published.definition,
      log: state.log,
      // The grants that apply to the actor (I8): the injected set, else the
      // bootstrap and the log through the directory, as a POST resolves them.
      grants:
        options.grants ?? grantsApplying(state.log, actor, options.bootstrap, options.membership),
    },
    options.resolve
  )
  if (view === undefined) {
    json(res, 403, { error: 'not readable' })
    return
  }
  json(res, 200, view)
}

/**
 * Serve one instance timeline (#246, S15, VT-5, I4, I8). The actor arrives as
 * the harness compatibility seam, exactly as it does for the instance read.
 * The instance's own events answer to `mayRead`; the flow's configuration
 * changes need `instance.timeline` on the flow.
 */
function serveInstanceTimeline(
  res: ServerResponse,
  url: string,
  state: State,
  options: ApiOptions
): void {
  const parsed = new URL(url, 'http://127.0.0.1')
  const suffix = '/timeline'
  const instanceId = decodeURIComponent(
    parsed.pathname.slice('/api/v1/instances/'.length, -suffix.length)
  )
  const actor = parsed.searchParams.get('actor')
  if (actor === null || actor === '') {
    json(res, 400, { error: 'the actor query parameter is required' })
    return
  }
  const instance = instanceOf(state.log, instanceId)
  if (instance === undefined) {
    json(res, 404, { error: 'not found' })
    return
  }
  const published = publishedByHash(state.log, instance.definitionVersion)
  if (published === undefined) {
    json(res, 404, { error: 'not found' })
    return
  }
  const grants =
    options.grants ?? grantsApplying(state.log, actor, options.bootstrap, options.membership)
  if (
    !mayRead(actor, instance, {
      flow: instance.flow,
      definition: published.definition,
      log: state.log,
      grants,
    })
  ) {
    json(res, 403, { error: 'not readable' })
    return
  }
  const requested = parsed.searchParams.get('includeChanges')
  const includeChanges = requested === '1' || requested === 'true'
  if (includeChanges && !authorize(grants, 'instance.timeline', `flow:${instance.flow}`)) {
    json(res, 403, { error: 'the flow changes need instance.timeline' })
    return
  }
  const events = state.log.filter(
    (event) =>
      event.payload.instanceId === instanceId ||
      (includeChanges &&
        isConfigChange(event.type) &&
        (flowOf(event) === instance.flow || event.type === TEAM_CHANGE_TYPE))
  )
  json(res, 200, timeline(events))
}

/** Serve the global change feed (#246, VT-6, I4, I8) through the harness seam. */
function serveTimeline(res: ServerResponse, url: string, state: State, options: ApiOptions): void {
  const parsed = new URL(url, 'http://127.0.0.1')
  const actor = parsed.searchParams.get('actor')
  if (actor === null || actor === '') {
    json(res, 400, { error: 'the actor query parameter is required' })
    return
  }
  const flow = parsed.searchParams.get('flow') ?? undefined
  const type = parsed.searchParams.get('type') ?? undefined
  const grants =
    options.grants ?? grantsApplying(state.log, actor, options.bootstrap, options.membership)
  const allowed = authorize(grants, 'org.grants', 'org')
  if (!allowed && flow === undefined) {
    json(res, 403, { error: 'the change feed needs instance.timeline or org.grants' })
    return
  }
  if (!allowed && flow !== undefined && !authorize(grants, 'instance.timeline', `flow:${flow}`)) {
    json(res, 403, { error: 'the change feed needs instance.timeline or org.grants' })
    return
  }
  json(
    res,
    200,
    timelineFor(state.log, {
      ...(flow === undefined ? {} : { flow }),
      ...(type === undefined ? {} : { type }),
    })
  )
}

/** Serve one interface file, or 404. */
function serveInterface(res: ServerResponse, urlPath: string): void {
  const asset = interfaceAsset(urlPath)
  if (asset === undefined) {
    json(res, 404, { error: 'not found' })
    return
  }
  let source: string
  try {
    source = readFileSync(asset.file, 'utf8')
  } catch {
    json(res, 404, { error: 'not found' })
    return
  }
  res.writeHead(200, { 'content-type': asset.type })
  res.end(asset.file.endsWith('.ts') ? transpileApp(source) : source)
}

export function startApi(state: State = emptyState, options: ApiOptions = {}): Api {
  let current = state
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? ''
      const url = req.url ?? ''
      if (method === 'POST' && url === '/api/v1/operations') {
        let parsed: unknown
        try {
          parsed = JSON.parse(await readBody(req))
        } catch {
          return json(res, 400, { error: 'invalid JSON body' })
        }
        // A client intent resolves through the same resolver as the release
        // server (ADR 0010, #256), so api mode proves the release write path.
        // The acting principal is the intent's actor (the harness has no
        // session), the grants and the directory are the injected seams, and
        // the server clock is the intent's own time, so a run is deterministic
        // (I6). An operation that a scenario declares resolved keeps the raw
        // append path.
        if (isRecord(parsed) && isClientIntent(parsed)) {
          // A retry of an applied intent is the same change (I1): the server
          // answers the event the log holds and resolves nothing again, as a
          // client whose first answer was lost expects.
          const applied =
            typeof parsed.id === 'string'
              ? current.log.find((event) => event.operationId === parsed.id)
              : undefined
          if (applied !== undefined) return json(res, 201, applied)
          const actor = typeof parsed.actor === 'string' ? parsed.actor : ''
          const at = typeof parsed.at === 'number' ? parsed.at : 0
          const groups = groupsOf(options.membership, actor)
          const directory = directoryOf(current.log, options.membership, options.managers)
          const resolved = resolveClientOperation(
            {
              log: current.log,
              principal: { id: actor, groups },
              grants:
                options.grants ??
                grantsApplying(current.log, actor, options.bootstrap, options.membership),
              resolver:
                options.resolve === undefined ? directory : () => options.resolve as TargetResolver,
              now: () => at,
            },
            parsed
          )
          if ('error' in resolved) {
            return json(res, resolved.status, {
              error: resolved.error,
              ...('errors' in resolved ? { errors: resolved.errors } : {}),
            })
          }
          current = apply(resolved.operation, current)
          return json(res, 201, current.log[current.log.length - 1])
        }
        if (!isOperation(parsed)) return json(res, 400, { error: 'invalid operation' })
        current = apply(parsed, current)
        return json(res, 201, current.log[current.log.length - 1])
      }
      if (method === 'GET' && new URL(url, 'http://127.0.0.1').pathname === '/api/v1/log') {
        // The polling fallback of the interface reads after a position
        // (#260, RT-1); the harness has no session, so it answers the whole
        // log after it.
        const query = new URL(url, 'http://127.0.0.1').searchParams
        const after = Number(query.get('after') ?? '0')
        const instance = query.get('instance')
        const flow = query.get('flow')
        return json(
          res,
          200,
          current.log.filter(
            (event) =>
              (!(Number.isInteger(after) && after > 0) || event.seq > after) &&
              (instance === null || event.payload.instanceId === instance) &&
              (flow === null ||
                flowOf(event) === flow ||
                (typeof event.payload.instanceId === 'string' &&
                  instanceOf(current.log, event.payload.instanceId)?.flow === flow))
          )
        )
      }
      if (method === 'GET' && url === '/api/v1/state') {
        return json(res, 200, { applied: [...current.applied], log: current.log })
      }
      if (method === 'GET' && url.startsWith('/api/v1/flows/')) {
        const slug = decodeURIComponent(url.slice('/api/v1/flows/'.length))
        const published = publishedFlow(current.log, slug)
        if (published === undefined) return json(res, 404, { error: 'not found' })
        return json(res, 200, {
          slug,
          version: published.version,
          contentHash: published.contentHash,
          definition: published.definition,
        })
      }
      if (
        method === 'GET' &&
        url.startsWith('/api/v1/instances/') &&
        new URL(url, 'http://127.0.0.1').pathname.endsWith('/timeline')
      ) {
        return serveInstanceTimeline(res, url, current, options)
      }
      if (method === 'GET' && url.startsWith('/api/v1/instances/')) {
        return serveInstanceRead(res, url, current, options)
      }
      if (method === 'GET' && new URL(url, 'http://127.0.0.1').pathname === '/api/v1/timeline') {
        return serveTimeline(res, url, current, options)
      }
      const uiPath = method === 'GET' ? interfacePath(url) : undefined
      if (uiPath !== undefined) return serveInterface(res, uiPath)
      return json(res, 404, { error: 'not found' })
    } catch {
      json(res, 500, { error: 'internal error' })
    }
  })
  return {
    server,
    state: () => current,
    port: () => (server.address() as { port: number } | null)?.port ?? 0,
  }
}
