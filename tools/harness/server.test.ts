import type { Server } from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startApi } from './server.js'

// Issue #24, DX-1, MVP.md 9.1: the api-mode story runs against the HTTP API
// that api/openapi.yaml describes. This check proves the in-process server
// serves that contract by delegating to the engine.

let port = 0
let server: Server

beforeAll(async () => {
  const api = startApi()
  server = api.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

const op = (id: string) => ({
  id,
  type: 'config.team.changed@1',
  at: 1,
  actor: 'user-1',
  payload: { name: 'registrar-office' },
})

test('#24 the api-mode server serves the /api/v1 contract', async () => {
  const created = await fetch(`http://127.0.0.1:${port}/api/v1/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(op('op-1')),
  })
  expect(created.status).toBe(201)
  const event = (await created.json()) as { seq: number; operationId: string }
  expect(event.seq).toBe(1)
  expect(event.operationId).toBe('op-1')

  const again = await fetch(`http://127.0.0.1:${port}/api/v1/operations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(op('op-1')),
  })
  expect(again.status).toBe(201)
  expect(((await again.json()) as { seq: number }).seq).toBe(1)

  const log = await fetch(`http://127.0.0.1:${port}/api/v1/log`)
  expect(log.status).toBe(200)
  expect((await log.json()) as unknown[]).toHaveLength(1)

  const state = await fetch(`http://127.0.0.1:${port}/api/v1/state`)
  expect(state.status).toBe(200)
  const body = (await state.json()) as { applied: string[] }
  expect(body.applied).toEqual(['op-1'])
})
