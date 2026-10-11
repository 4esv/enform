import type { Server } from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { apply, emptyState } from '../../engine/apply.js'
import { createFlow, publish, publishedFlow, push } from '../../engine/flow.js'
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

test('#172 the api-mode server reads the published flow by slug', async () => {
  // Build a log with two published versions of one flow (DF-2). The newest
  // publication is the one that the read must return.
  const slug = 'registration'
  const first = { schemaVersion: 1, steps: [{ key: 'submit', targets: [{ user: 'dana' }] }] }
  const second = {
    schemaVersion: 1,
    steps: [
      { key: 'submit', targets: [{ user: 'dana' }] },
      { key: 'review', targets: [{ user: 'chris' }] },
    ],
  }
  const deps = (index: number) => ({ clock: () => index, ids: () => `op-${index}` })

  let flow = createFlow(slug)
  const firstPush = push(flow, first, deps(1), 'dana')
  flow = firstPush.flow
  const firstPublish = publish(flow, deps(2), 'dana')
  flow = firstPublish.flow
  const secondPush = push(flow, second, deps(3), 'dana')
  flow = secondPush.flow
  const secondPublish = publish(flow, deps(4), 'dana')
  flow = secondPublish.flow
  const [, pinned] = flow.versions

  let state = emptyState
  for (const operation of [
    firstPush.operation,
    firstPublish.operation,
    secondPush.operation,
    secondPublish.operation,
  ]) {
    state = apply(operation, state)
  }

  // The engine derives the newest publication from the log, and returns
  // undefined when the log has none for the slug.
  expect(publishedFlow(state.log, slug)).toEqual(pinned)
  expect(publishedFlow(state.log, 'missing')).toBeUndefined()
  expect(publishedFlow([], slug)).toBeUndefined()

  // The server serves the same derivation over HTTP (DX-1).
  const api = startApi(state)
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${api.port()}`
    const read = await fetch(`${base}/api/v1/flows/${slug}`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({
      slug,
      version: pinned.version,
      contentHash: pinned.contentHash,
      definition: pinned.definition,
    })

    const missing = await fetch(`${base}/api/v1/flows/missing`)
    expect(missing.status).toBe(404)
  } finally {
    await new Promise<void>((resolve, reject) =>
      api.server.close((err) => (err ? reject(err) : resolve()))
    )
  }
})
