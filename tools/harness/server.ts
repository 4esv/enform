import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { publishedFlow } from '../../engine/flow.js'
import type { Operation } from '../../engine/operation.js'

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
  if (path.startsWith('/app/') || path.startsWith('/client/')) return path.replace(/^\/+/, '')
  return undefined
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

export function startApi(state: State = emptyState): Api {
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
        if (!isOperation(parsed)) return json(res, 400, { error: 'invalid operation' })
        current = apply(parsed, current)
        return json(res, 201, current.log[current.log.length - 1])
      }
      if (method === 'GET' && url === '/api/v1/log') {
        return json(res, 200, current.log)
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
