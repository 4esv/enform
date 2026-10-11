import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
// Issue #181, FM-1, ADR 0009: it also serves the app shell from interface/app
// so a browser can open it. The TypeScript source is served as a JavaScript
// module; gui mode supplies the type stripping. The app files are read from
// disk here; the server never imports an interface module.

export type Api = {
  server: Server
  state: () => State
  port: () => number
}

/** The directory that holds the browser app (index.html, app.ts, form.ts). */
const APP_DIR = fileURLToPath(new URL('../../interface/app/', import.meta.url))

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

/** The content type of an app asset, or undefined for an unknown extension. */
function appContentType(path: string): string | undefined {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.ts')) return 'text/javascript; charset=utf-8'
  return undefined
}

/**
 * Resolve one /app/ subpath to a file inside interface/app, and refuse any
 * path that escapes the directory (I12, ADR 0009). An unknown extension or a
 * malformed path answers undefined.
 */
function appAsset(subpath: string): { file: string; type: string } | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(subpath)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const file = resolve(APP_DIR, decoded)
  const rel = relative(APP_DIR, file)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined
  }
  const type = appContentType(file)
  if (type === undefined) return undefined
  return { file, type }
}

function serveApp(res: ServerResponse, subpath: string): void {
  const asset = appAsset(subpath)
  if (asset === undefined) {
    json(res, 404, { error: 'not found' })
    return
  }
  let body: Buffer
  try {
    body = readFileSync(asset.file)
  } catch {
    json(res, 404, { error: 'not found' })
    return
  }
  res.writeHead(200, { 'content-type': asset.type })
  res.end(body)
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
      if (method === 'GET' && (url === '/app' || url === '/app/' || url.startsWith('/app/'))) {
        const subpath = url === '/app' || url === '/app/' ? 'index.html' : url.slice('/app/'.length)
        return serveApp(res, subpath)
      }
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
