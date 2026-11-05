import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { apply, emptyState } from '../engine/apply.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #264, S03, S04, DF-6, I8, I14: the diff route. A person who may read
// the flow reads the attributed difference between two points of its
// history: two published versions, or a version and the draft, each change
// with its path, its class, its author and its time. The parent of a point
// is the default `from`. The draft is the working copy, so a point at the
// draft needs a draft scope; a version needs only a flow read scope. An
// unknown version is 404 and a point that is neither a number nor `draft` is
// 400. The route reads the log and writes nothing.

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

const priyaFixesLabel = withLabel(base, 'Summary')
const danaAddsField = withReasonField(priyaFixesLabel)

/** Version 1 by Dana, Priya's label fix, Dana's field, version 2 by Dana; the draft equals version 2. */
function flowLog() {
  const deps = (id: string, at: number) => ({ clock: () => at, ids: () => id })
  let flow = createFlow('course-overload')
  const operations = []
  const first = push(flow, base, deps('push-1', 1), 'user:dana')
  flow = first.flow
  operations.push(first.operation)
  const v1 = publish(flow, deps('publish-1', 2), 'user:dana')
  flow = v1.flow
  operations.push(v1.operation)
  const second = push(flow, priyaFixesLabel, deps('push-2', 3), 'user:priya')
  flow = second.flow
  operations.push(second.operation)
  const third = push(flow, danaAddsField, deps('push-3', 4), 'user:dana')
  flow = third.flow
  operations.push(third.operation)
  const v2 = publish(flow, deps('publish-2', 5), 'user:dana')
  operations.push(v2.operation)
  let state = emptyState
  for (const operation of operations) state = apply(operation, state)
  return state.log
}

/** The appended operations the route wrote: none. */
const appended: { type: unknown }[] = []

function sessionPool(grants: readonly Record<string, unknown>[]): Pool {
  const now = Date.now()
  const log = flowLog()
  return {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith('insert into events')) {
          appended.push({ type: values?.[1] })
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
          rows: [{ title: null, draft: danaAddsField, draft_version: 3, updated_at: String(now) }],
        })
      }
      if (text.includes('from flow_versions')) {
        return Promise.resolve({
          rows: [
            { version: 1, content_hash: contentHash(base), definition: base },
            { version: 2, content_hash: contentHash(danaAddsField), definition: danaAddsField },
          ],
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
const startGrant = {
  principal: 'user:priya',
  scopes: ['instance.start'],
  resource: 'flow:course-overload',
}

async function read(pool: Pool, query: string): Promise<Response> {
  const app = createApp(defaultConfig, pool)
  return app.request(`/api/v1/flows/course-overload/diff${query}`, { headers: { cookie } })
}

type Diff = {
  slug: string
  from: string
  to: string
  changes: { path: string; class: string; actor?: string; at?: number }[]
}

test.fails('#264 DF-6 S03 S04 the diff between two points names each change with its author, and defaults to the parent', async () => {
  appended.length = 0
  const pool = sessionPool([editGrant])
  const between = await read(pool, '?from=1&to=2')
  const body = await between.text()
  expect(between.status, body).toBe(200)
  const diff = JSON.parse(body) as Diff
  expect(diff.slug).toBe('course-overload')
  expect(diff.from).toBe('1')
  expect(diff.to).toBe('2')
  expect(diff.changes).toEqual([
    expect.objectContaining({
      path: '/steps/request/fields/summary/label',
      class: 'edit',
      actor: 'user:priya',
      at: 3,
    }),
    expect.objectContaining({
      path: '/steps/request/fields/reason_category',
      class: 'structural',
      actor: 'user:dana',
      at: 4,
    }),
  ])
  // The parent is the default: version 2 from version 1, the draft from the
  // newest version, and the draft is the default point.
  expect((await (await read(pool, '?to=2')).json()) as Diff).toEqual(diff)
  const draft = (await (await read(pool, '')).json()) as Diff
  expect(draft.from).toBe('2')
  expect(draft.to).toBe('draft')
  expect(draft.changes).toEqual([])
  expect(appended).toEqual([])
})

test.fails('#264 I8 a version needs a flow read scope, the draft needs a draft scope, and a bad point is refused', async () => {
  const starter = sessionPool([startGrant])
  expect((await read(starter, '?from=1&to=2')).status).toBe(200)
  expect((await read(starter, '?to=draft')).status).toBe(403)
  expect((await read(sessionPool([]), '?from=1&to=2')).status).toBe(403)
  const editor = sessionPool([editGrant])
  expect((await read(editor, '?from=1&to=7')).status).toBe(404)
  expect((await read(editor, '?to=latest')).status).toBe(400)
  expect((await read(editor, '?from=0&to=1')).status).toBe(400)
})
