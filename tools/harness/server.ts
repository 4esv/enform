import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Operation } from '../../engine/operation.js'

// Issue #24, DX-1, MVP.md 9.1: the in-process HTTP API that api/openapi.yaml
// describes. It delegates to the engine (apply, the append-only log). It is
// harness infrastructure, not the release server (deploy/compose.yaml defers
// that image to a later milestone).

export type Api = {
  server: Server
  state: () => State
  port: () => number
}

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
