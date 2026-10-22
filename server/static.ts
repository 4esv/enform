// Issue #224, DX-4, I12, ADR 0009: the release server serves the interface at
// the site root, so a person who opens the configured URL reaches the app. The
// app is TypeScript and ADR 0009 has no build step, so the server transpiles a
// module on the way out exactly as the story harness does: a browser does not
// strip types, and a module specifier names the emitted `.js` file. The API
// stays under `/api/v1`, and `/healthz`, `/readyz` and `/version` are routes of
// their own, so this module adds only `/`, `/app` and `/client`.

import { existsSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Hono } from 'hono'

/** The content type of an interface asset, or undefined for an unknown extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/**
 * The directory that holds the interface. A source checkout keeps it beside
 * `server/`; the release image copies `interface/` beside `dist/`
 * (deploy/Dockerfile), so the same module reads both layouts.
 */
function interfaceDirectory(): string {
  for (const candidate of ['../interface/', '../../interface/']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  return fileURLToPath(new URL('../interface/', import.meta.url))
}

/**
 * Resolve one URL path to a file inside `interface/`, and refuse any path that
 * escapes it or names an extension the interface does not serve (I12, ADR
 * 0009). `/` and `/app/` are the app's index page, `/app/*` is the app and
 * `/client/*` is the generated client, so a module specifier relative to
 * `/app/app.js` finds `/client/client.js`.
 */
function interfaceAsset(urlPath: string): { file: string; type: string } | undefined {
  let path: string
  try {
    path = decodeURIComponent(urlPath)
  } catch {
    return undefined
  }
  if (path.includes('\0')) return undefined
  const relativePath = interfaceRelative(path)
  if (relativePath === undefined) return undefined
  const root = interfaceDirectory()
  const file = resolve(root, relativePath)
  const fromRoot = relative(root, file)
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    return undefined
  }
  // A module specifier names the emitted `.js` file (the TypeScript ESM
  // convention). There is no build step (ADR 0009), so the source stands in
  // for its output and the server strips its types below.
  const candidate =
    !existsSync(file) && file.endsWith('.js') ? `${file.slice(0, -'.js'.length)}.ts` : file
  if (!existsSync(candidate)) return undefined
  const type = CONTENT_TYPES[candidate.slice(candidate.lastIndexOf('.'))]
  if (type === undefined) return undefined
  return { file: candidate, type }
}

/** The path inside `interface/` that a URL names, or undefined for another route. */
function interfaceRelative(path: string): string | undefined {
  if (path === '/' || path === '/app' || path === '/app/') return 'app/index.html'
  if (path.startsWith('/app/') || path.startsWith('/client/')) return path.replace(/^\/+/, '')
  return undefined
}

/** Strip the types from one app module, so a browser receives the JavaScript it runs (ADR 0009). */
function transpile(source: string): string {
  return stripTypeScriptTypes(source, { mode: 'strip' })
}

/** Serve one interface file, or 404. */
function serveInterface(c: Context) {
  const asset = interfaceAsset(c.req.path)
  if (asset === undefined) return c.json({ error: 'not found' }, 404)
  let source: string
  try {
    source = readFileSync(asset.file, 'utf8')
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
  return c.body(asset.file.endsWith('.ts') ? transpile(source) : source, 200, {
    'content-type': asset.type,
  })
}

/**
 * Mount the interface routes on the release app. The API is registered before
 * this call, so `/api/v1` keeps its routes and no interface pattern covers
 * `/healthz`, `/readyz` or `/version`.
 */
export function mountInterface(app: Hono): void {
  app.get('/', serveInterface)
  app.get('/app', serveInterface)
  app.get('/app/', serveInterface)
  app.get('/app/*', serveInterface)
  app.get('/client/*', serveInterface)
}
