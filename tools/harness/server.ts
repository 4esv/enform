import { createServer, type Server } from 'node:http'
import { emptyState, type State } from '../../engine/apply.js'

// Issue #24, DX-1: the in-process HTTP API that api/openapi.yaml describes.
// Scaffolding: every route answers 501 until the engine delegation lands in
// the implementation commit.

export type Api = {
  server: Server
  state: () => State
  port: () => number
}

export function startApi(state: State = emptyState): Api {
  const server = createServer((_req, res) => {
    res.writeHead(501)
    res.end()
  })
  return {
    server,
    state: () => state,
    port: () => (server.address() as { port: number } | null)?.port ?? 0,
  }
}
