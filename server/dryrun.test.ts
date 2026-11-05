import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { apply, emptyState } from '../engine/apply.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #264, DR-1, DR-3, DR-4, DR-5, DR-6, I8, I14, S05, S08: the dry-run
// route. A person with a dry-run scope runs a published version or the
// draft with data and reads the route, the assignees, the preview inbox and
// the timers; the run writes no event. Running as another person needs
// org.impersonate, and the log records that use. The checks run over a pool
// that answers one cookie session, the grants rows, the flow projection and
// the log, as the auth checks do.

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "overload_credits", "control": "number" }, { "key": "advisor", "control": "user" }]
    },
    {
      "key": "advisor",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve"],
      "reminderMinutes": 1440,
      "deadlineMinutes": 4320
    },
    {
      "key": "chair",
      "targets": [{ "group": "CS-Chairs" }],
      "outcomes": ["approve"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    }
  ]
}
`)

/** The log: version 1 published by Dana. */
function publishedLog() {
  const deps = (id: string) => ({ clock: () => 1, ids: () => id })
  const pushed = push(createFlow('course-overload'), definition, deps('push-1'), 'user:dana')
  const released = publish(pushed.flow, deps('publish-1'), 'user:dana')
  return apply(released.operation, apply(pushed.operation, emptyState)).log
}

/** The appended operations the route wrote, so a test can read the impersonation record. */
const appended: Record<string, unknown>[] = []

function sessionPool(grants: readonly Record<string, unknown>[]): Pool {
  const now = Date.now()
  const log = publishedLog()
  return {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith('insert into events')) {
          appended.push({ type: values?.[1], payload: JSON.parse(String(values?.[4])) })
          return { rows: [{ seq: String(log.length + appended.length) }] }
        }
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
          rows: [{ title: null, draft: definition, draft_version: 2, updated_at: String(now) }],
        })
      }
      if (text.includes('from flow_versions')) {
        return Promise.resolve({
          rows: [{ version: 1, content_hash: 'hash', definition }],
        })
      }
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Pool
}

const cookie = `${defaultConfig.session.cookieName}=session-1`
const dryrunGrant = {
  principal: 'user:priya',
  scopes: ['flow.dryrun'],
  resource: 'flow:course-overload',
}

async function run(pool: Pool, body: Record<string, unknown>): Promise<Response> {
  const app = createApp(defaultConfig, pool)
  return app.request('/api/v1/flows/course-overload/dry-run', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'csrf-1' },
    body: JSON.stringify(body),
  })
}

test('#264 DR-1 DR-3 DR-4 a dry run of a version or the draft answers the route, the assignees, the inbox and the timers, and writes nothing', async () => {
  appended.length = 0
  const pool = sessionPool([dryrunGrant])
  const response = await run(pool, {
    version: 1,
    data: { overload_credits: 2, advisor: 'user:okafor' },
    advanceMinutes: 1440,
  })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  const result = JSON.parse(body) as {
    flow: string
    version: unknown
    actor: string
    route: { active: string[]; skipped: { step: string }[] }
    assignees: { step: string; members: string[] }[]
    next?: string
    intents: { operation: string; payload: { to: string } }[]
    timers: { kind: string; fired: boolean }[]
  }
  expect(result.flow).toBe('course-overload')
  expect(result.version).toBe(1)
  expect(result.actor).toBe('user:priya')
  expect(result.route.active).toEqual(['request', 'advisor'])
  expect(result.route.skipped.map((step) => step.step)).toEqual(['chair'])
  expect(result.assignees.find((entry) => entry.step === 'advisor')?.members).toEqual([
    'user:okafor',
  ])
  expect(result.next).toBe('advisor')
  expect(result.intents.map((intent) => [intent.operation, intent.payload.to])).toEqual([
    ['send-assignment', 'user:okafor'],
    ['send-reminder', 'user:okafor'],
  ])
  expect(result.timers.filter((timer) => timer.fired)).toHaveLength(1)
  expect(appended).toEqual([])
  // The draft runs the same way; an unpublished version is 404; a body
  // without data is 400.
  const draft = await run(pool, { version: 'draft', data: { overload_credits: 4 } })
  expect(draft.status, await draft.clone().text()).toBe(200)
  expect(((await draft.json()) as { route: { active: string[] } }).route.active).toContain('chair')
  expect((await run(pool, { version: 7, data: {} })).status).toBe(404)
  expect((await run(pool, { version: 1 })).status).toBe(400)
})

test('#264 DR-5 I8 running as another person needs org.impersonate and the log records the use', async () => {
  appended.length = 0
  const refused = await run(sessionPool([dryrunGrant]), {
    version: 1,
    data: { overload_credits: 2 },
    as: 'user:sam',
  })
  expect(refused.status).toBe(403)
  expect(appended).toEqual([])
  const allowed = await run(
    sessionPool([
      dryrunGrant,
      { principal: 'user:priya', scopes: ['org.impersonate'], resource: 'org' },
    ]),
    { version: 1, data: { overload_credits: 2 }, as: 'user:sam' }
  )
  expect(allowed.status, await allowed.clone().text()).toBe(200)
  expect(((await allowed.json()) as { actor: string }).actor).toBe('user:sam')
  expect(appended).toEqual([
    { type: 'dryrun.ran@1', payload: { flow: 'course-overload', version: 1, as: 'user:sam' } },
  ])
  // Without a dry-run scope the run is refused (I8).
  expect((await run(sessionPool([]), { version: 1, data: {} })).status).toBe(403)
})
