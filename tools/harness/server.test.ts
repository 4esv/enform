import type { Server } from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { createFlow, publish, publishedFlow, push } from '../../engine/flow.js'
import { addGrant } from '../../engine/grants.js'
import {
  INSTANCE_ID,
  resolve,
  SLUG,
  samGrants,
  versionV1,
} from '../../stories/S06-start-submission/scenario.js'
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

test('#181 the harness server serves the app shell and refuses escapes', async () => {
  const index = await fetch(`http://127.0.0.1:${port}/app/`)
  expect(index.status).toBe(200)
  expect(index.headers.get('content-type')).toContain('text/html')
  expect(await index.text()).toContain('id="app"')

  const html = await fetch(`http://127.0.0.1:${port}/app/index.html`)
  expect(html.status).toBe(200)
  expect(html.headers.get('content-type')).toContain('text/html')

  const script = await fetch(`http://127.0.0.1:${port}/app/app.ts`)
  expect(script.status).toBe(200)
  expect(script.headers.get('content-type')).toContain('text/javascript')
  expect(await script.text(), 'a .ts request is served as JavaScript').not.toMatch(
    /^export interface /m
  )

  // A module specifier in the app names the emitted .js file, and no build
  // step exists (ADR 0009), so the server stands the source in for it (#181).
  const module = await fetch(`http://127.0.0.1:${port}/app/form.js`)
  expect(module.status).toBe(200)
  expect(module.headers.get('content-type')).toContain('text/javascript')
  const source = await module.text()
  expect(source, 'the served module is JavaScript, not TypeScript').not.toMatch(
    /^export interface /m
  )
  expect(source, 'the module keeps a specifier the browser can fetch').toContain('export function')

  // The app imports the generated client as a sibling of its own directory,
  // so the interface is served at the site root (I12, ADR 0009).
  const client = await fetch(`http://127.0.0.1:${port}/client/client.js`)
  expect(client.status).toBe(200)
  expect(await client.text()).toContain('export async function')

  // The form link carries the flow, so the query string is not part of the path.
  const link = await fetch(`http://127.0.0.1:${port}/app/?slug=course-overload`)
  expect(link.status).toBe(200)
  expect(link.headers.get('content-type')).toContain('text/html')

  const unknown = await fetch(`http://127.0.0.1:${port}/app/not-here.js`)
  expect(unknown.status).toBe(404)

  const traversal = await fetch(`http://127.0.0.1:${port}/app/%2e%2e/%2e%2e/package.json`)
  expect(traversal.status).toBe(404)
})

// Issue #184, ADR 0010, DX-1, A9, I13, WF-1, DF-2, FM-7: a client posts an
// intent, and the server resolves the rest through the engine before it
// appends. The appended event keeps the client's ID and time.

/** A log with the published S06 flow and Sam's start grant, read back from the log (I4, AC-1). */
function intentState(): State {
  const deps = (n: number) => ({ clock: () => n, ids: () => `setup-${n}` })
  let flow = createFlow(SLUG)
  const pushed = push(flow, versionV1.definition, deps(1), 'dana')
  flow = pushed.flow
  const published = publish(flow, deps(2), 'dana')
  flow = published.flow
  let state = emptyState
  for (const operation of [
    pushed.operation,
    published.operation,
    ...samGrants.map((grant, index) => addGrant(grant, 'dana', deps(3 + index))),
  ]) {
    state = apply(operation, state)
  }
  return state
}

/** Start the server on a loopback port, and close it when the callback returns. */
async function withApi(
  state: State,
  options: Parameters<typeof startApi>[1],
  body: (base: string, api: ReturnType<typeof startApi>) => Promise<void>
): Promise<void> {
  const api = startApi(state, options)
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve))
  try {
    await body(`http://127.0.0.1:${api.port()}`, api)
  } finally {
    await new Promise<void>((resolve, reject) =>
      api.server.close((err) => (err ? reject(err) : resolve()))
    )
  }
}

test('#184 a posted intent resolves to the engine operation and keeps the client id and time', async () => {
  await withApi(intentState(), { resolve }, async (base, api) => {
    const intent = {
      id: 'intent-1',
      type: 'instance.started@1',
      at: 5,
      actor: 'user:sam',
      payload: { flow: SLUG, instanceId: INSTANCE_ID, values: { urgent: false } },
    }
    const before = api.state().log.length
    const response = await fetch(`${base}/api/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    })
    expect(response.status).toBe(201)
    const event = (await response.json()) as {
      operationId: string
      type: string
      at: number
      actor: string
      payload: Record<string, unknown>
    }
    expect(event.operationId).toBe('intent-1')
    expect(event.at).toBe(5)
    expect(event.type).toBe('instance.started@1')
    expect(event.actor).toBe('user:sam')
    expect(event.payload).toEqual({
      instanceId: INSTANCE_ID,
      definitionVersion: versionV1.contentHash,
      currentStep: 'advisor',
      assignees: [{ step: 'advisor', target: { user: 'user:okafor' }, members: ['user:okafor'] }],
      starter: 'user:sam',
      values: { urgent: false },
      skipped: [{ step: 'triage', condition: { '==': [{ var: 'urgent' }, false] } }],
    })
    expect(api.state().log).toHaveLength(before + 1)
    expect(api.state().log.at(-1)?.operationId).toBe('intent-1')
  })
})

test('#184 an unresolvable intent is refused with a named error and appends nothing', async () => {
  await withApi(emptyState, {}, async (base, api) => {
    const intent = {
      id: 'intent-2',
      type: 'instance.started@1',
      at: 6,
      actor: 'user:sam',
      payload: { flow: 'missing', instanceId: INSTANCE_ID, values: {} },
    }
    const response = await fetch(`${base}/api/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toMatch(/no published version/)
    expect(api.state().log).toHaveLength(0)
  })
})

// Issue #187, DX-1, ADR 0010, I1, I13: the intent carries the instance id the
// client minted, and the server refuses an intent that lacks one by shape, as
// it already does for the id, the time, the actor and the values.

test('#187 an intent without an instance id is refused with a named error and appends nothing', async () => {
  await withApi(intentState(), { resolve }, async (base, api) => {
    const intent = {
      id: 'intent-3',
      type: 'instance.started@1',
      at: 7,
      actor: 'user:sam',
      payload: { flow: SLUG, values: { urgent: false } },
    }
    const before = api.state().log.length
    const response = await fetch(`${base}/api/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toMatch(
      /instanceId must be a string/
    )
    expect(api.state().log).toHaveLength(before)
  })
})

// Issue #76, FM-3, FM-7, VT-4, DX-1, I8: the HTTP API reads one instance as a
// step sees it. The actor arrives as the `actor` query parameter, because the
// harness has no real authentication. The engine authorizes the read (I8), so
// an actor that may not read the instance answers 403 and an instance the log
// does not hold answers 404.

test('#76 the api-mode server reads one instance and refuses the rest (I8)', async () => {
  await withApi(intentState(), { resolve }, async (base) => {
    // Start the S06 instance through a posted intent (ADR 0010).
    const start = await fetch(`${base}/api/v1/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'read-start',
        type: 'instance.started@1',
        at: 10,
        actor: 'user:sam',
        payload: { flow: SLUG, instanceId: INSTANCE_ID, values: { urgent: false } },
      }),
    })
    expect(start.status).toBe(201)

    // Sam started the instance, so he reads it (AC-5). The S06 start routes to
    // `advisor`, which declares no fields, so nothing is visible and the values
    // are absent from the response (FM-3).
    const read = await fetch(`${base}/api/v1/instances/${INSTANCE_ID}?actor=user:sam`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({
      instanceId: INSTANCE_ID,
      status: {
        step: 2,
        totalSteps: 3,
        currentStep: 'advisor',
        state: 'waiting',
        skipped: [{ step: 'triage', condition: { '==': [{ var: 'urgent' }, false] } }],
      },
      visible: [],
      editable: [],
      required: [],
      collapsed: [],
      values: {},
    })

    // An actor that may not read the instance is refused (I8).
    const forbidden = await fetch(`${base}/api/v1/instances/${INSTANCE_ID}?actor=user:outsider`)
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: 'not readable' })

    // An instance the log does not hold is not found.
    const missing = await fetch(`${base}/api/v1/instances/missing?actor=user:sam`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })
  })
})
