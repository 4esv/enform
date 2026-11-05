import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { apply, emptyState } from '../engine/apply.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #264, S03, DF-3, DF-5, I1, I4, I5: two people write one draft at the
// same time and nobody is blocked. A draft read names the content hash of
// the draft, a write names the hash it is based on, and a write whose base is
// no longer the draft merges with the draft three ways (engine/merge.ts): the
// changes of both land, the write records only its own change, and the
// answer carries the merged draft. A place both changed differently is a
// conflict: the write answers 409 with the conflicting paths and appends
// nothing, so the writer re-reads and decides (A1). A write without a base
// keeps the version check it always had.

const base = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "label": "Sumary", "required": true },
        { "key": "overload_credits", "control": "number", "label": "Overload credits" }
      ]
    },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve"] }
  ]
}`)

function withLabel(from: FlowDefinition, label: string): FlowDefinition {
  const doc = JSON.parse(JSON.stringify(from)) as {
    steps: { fields: { label: string }[] }[]
  }
  doc.steps[0].fields[0].label = label
  return parse(JSON.stringify(doc))
}

function withReasonField(from: FlowDefinition): FlowDefinition {
  const doc = JSON.parse(JSON.stringify(from)) as { steps: { fields: unknown[] }[] }
  doc.steps[0].fields.push({ key: 'reason_category', control: 'text', required: true })
  return parse(JSON.stringify(doc))
}

/** Priya's edit of the base: the typing error in the label. */
const priyaFixesLabel = withLabel(base, 'Summary')
/** Dana's write that reached the draft first: a new required field. */
const danaAddsField = withReasonField(base)

/** The log: version 1 published by Dana from the base, then Dana's second push. */
function flowLog() {
  const deps = (id: string) => ({ clock: () => 1, ids: () => id })
  const pushed = push(createFlow('course-overload'), base, deps('push-1'), 'user:dana')
  const released = publish(pushed.flow, deps('publish-1'), 'user:dana')
  const edited = push(released.flow, danaAddsField, deps('push-2'), 'user:dana')
  let state = emptyState
  for (const operation of [pushed.operation, released.operation, edited.operation]) {
    state = apply(operation, state)
  }
  return state.log
}

/** The appended operations the route wrote. */
const appended: { type: unknown; actor: unknown; payload: Record<string, unknown> }[] = []

function sessionPool(grants: readonly Record<string, unknown>[]): Pool {
  const now = Date.now()
  const log = flowLog()
  return {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith('insert into events')) {
          appended.push({
            type: values?.[1],
            actor: values?.[3],
            payload: JSON.parse(String(values?.[4])),
          })
          return { rows: [{ seq: String(log.length + appended.length) }] }
        }
        if (text.includes('coalesce(max(version)')) return { rows: [{ next: 2 }] }
        return { rows: [] }
      },
      release: () => undefined,
    }),
    query: (text: string) => {
      if (text.includes('from sessions')) {
        return Promise.resolve({
          rows: [
            {
              id: 'session-1',
              principal_id: 'user:priya',
              csrf_token: 'csrf-1',
              created_at: String(now),
              expires_at: String(now + 3_600_000),
              last_seen_at: String(now),
              revoked_at: null,
              refresh_token: null,
            },
          ],
        })
      }
      if (text.includes('from principals')) {
        return Promise.resolve({
          rows: [{ id: 'user:priya', display_name: 'Priya', email: null, groups: [] }],
        })
      }
      if (text.includes('from grants')) return Promise.resolve({ rows: grants })
      if (text.includes('from events')) {
        return Promise.resolve({
          rows: log.map((event) => ({
            seq: String(event.seq),
            operation_id: event.operationId,
            type: event.type,
            at: String(event.at),
            actor: event.actor ?? null,
            payload: event.payload,
          })),
        })
      }
      if (text.includes('from flows')) {
        return Promise.resolve({
          rows: [{ title: null, draft: danaAddsField, draft_version: 2, updated_at: String(now) }],
        })
      }
      if (text.includes('from flow_versions')) {
        return Promise.resolve({
          rows: [{ version: 1, content_hash: contentHash(base), definition: base }],
        })
      }
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Pool
}

const cookie = `${defaultConfig.session.cookieName}=session-1`
const editGrant = {
  principal: 'user:priya',
  scopes: ['flow.edit'],
  resource: 'flow:course-overload',
}

async function write(pool: Pool, body: Record<string, unknown>): Promise<Response> {
  const app = createApp(defaultConfig, pool)
  return app.request('/api/v1/flows/course-overload/draft', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' },
    body: JSON.stringify(body),
  })
}

test('#264 S03 DF-3 a write based on an older draft merges with the draft, and only its own change is recorded', async () => {
  appended.length = 0
  const pool = sessionPool([editGrant])
  // The read names the hash of the draft a write is based on.
  const app = createApp(defaultConfig, pool)
  const read = await app.request('/api/v1/flows/course-overload/draft', { headers: { cookie } })
  expect(read.status, await read.clone().text()).toBe(200)
  expect(((await read.json()) as { draftHash: string }).draftHash).toBe(contentHash(danaAddsField))

  // Priya read the base, fixed the label, and writes after Dana's push.
  const response = await write(pool, {
    version: 2,
    definition: priyaFixesLabel,
    baseHash: contentHash(base),
  })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  const written = JSON.parse(body) as {
    version: number
    draftHash: string
    definition: FlowDefinition
    changes: { path: string; class: string }[]
  }
  const merged = withLabel(danaAddsField, 'Summary')
  expect(written.definition).toEqual(merged)
  expect(written.draftHash).toBe(contentHash(merged))
  expect(written.version).toBe(2)
  // The write records its own change only: the label, edit-class, which is
  // what flow.edit allows (DF-5); Dana's field is not Priya's change.
  expect(written.changes).toEqual([
    expect.objectContaining({ path: '/steps/request/fields/summary/label', class: 'edit' }),
  ])
  expect(appended).toEqual([
    {
      type: 'config.definition.changed@1',
      actor: 'user:priya',
      payload: { flow: 'course-overload', definition: merged },
    },
  ])
})

test('#264 S03 a place both changed differently is a conflict: 409 with the paths, and nothing is appended', async () => {
  appended.length = 0
  const pool = sessionPool([editGrant])
  const danaRenamedToo = sessionPoolWithDraft(pool, withLabel(danaAddsField, 'Request summary'))
  const response = await write(danaRenamedToo, {
    version: 2,
    definition: priyaFixesLabel,
    baseHash: contentHash(base),
  })
  const body = await response.text()
  expect(response.status, body).toBe(409)
  const refused = JSON.parse(body) as {
    code: string
    conflicts: { path: string; ours: unknown; theirs: unknown }[]
  }
  expect(refused.code).toBe('version-stale')
  expect(refused.conflicts).toEqual([
    {
      path: '/steps/request/fields/summary/label',
      base: 'Sumary',
      ours: 'Summary',
      theirs: 'Request summary',
    },
  ])
  expect(appended).toEqual([])
  // A base the log does not hold cannot merge: the write is stale as before.
  const unknown = await write(pool, { version: 2, definition: priyaFixesLabel, baseHash: 'none' })
  expect(unknown.status).toBe(409)
  expect(((await unknown.json()) as { conflicts?: unknown }).conflicts).toBeUndefined()
  // A stale version without a base is refused as it always was (I5).
  expect((await write(pool, { version: 1, definition: priyaFixesLabel })).status).toBe(409)
  expect(appended).toEqual([])
})

/** The same pool with another current draft. */
function sessionPoolWithDraft(pool: Pool, draft: FlowDefinition): Pool {
  const query = pool.query.bind(pool) as (text: string) => Promise<{ rows: unknown[] }>
  return {
    ...pool,
    connect: pool.connect.bind(pool),
    query: (text: string) =>
      text.includes('from flows')
        ? Promise.resolve({
            rows: [{ title: null, draft, draft_version: 2, updated_at: String(Date.now()) }],
          })
        : query(text),
  } as unknown as Pool
}
