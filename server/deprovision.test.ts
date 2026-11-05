import type { Pool } from 'pg'
import { afterEach, expect, test, vi } from 'vitest'
import { claim } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { instanceOf } from '../engine/instances.js'
import { USER_DEPROVISIONED } from '../engine/membership.js'
import type { OperationDeps } from '../engine/operation.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { TASK_RELEASED } from '../engine/undo.js'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #267, ID-5, ID-6, I4, I8, I14, WF-5: the deprovision route. An
// administrator with `org.grants` deprovisions one directory user: the server
// disables the account in the identity provider, the engine releases every
// task the person held through `task.released@1` with the reason and records
// `user.deprovisioned@1`, and the route answers what it released. A principal
// without the scope is refused before the directory is touched, an unknown
// principal answers 404, and a second deprovision appends nothing. The checks
// run over a pool that answers one cookie session, the grants, the log and
// the held instances, and over a stubbed identity provider.

const ADMIN = 'user:dana'
const OKAFOR = 'user:okafor'
const SAM = 'user:sam'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "advisor", "control": "user" }],
      "editable": ["advisor"]
    },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve"] }
  ]
}
`)

function deps(id: string, at: number): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/** The log: version 1 published, Sam's request routed to Dr. Okafor, who claimed it. */
function claimedLog(): State['log'] {
  const pushed = push(createFlow('course-overload'), definition, deps('push', 1), ADMIN)
  const released = publish(pushed.flow, deps('publish', 2), ADMIN)
  let state = apply(released.operation, apply(pushed.operation, emptyState))
  const resolve = (target: Record<string, unknown>) =>
    'starter' in target ? [SAM] : 'field' in target ? [OKAFOR] : []
  const grants = [{ principal: SAM, scopes: ['instance.start'], resource: 'flow:course-overload' }]
  const started = startInstance(
    { slug: 'course-overload', versions: released.flow.versions },
    'inst-1',
    { advisor: OKAFOR },
    SAM,
    deps('op-1', 3),
    resolve,
    grants
  )
  state = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: 'course-overload', definition, resolve, grants },
    deps('op-2', 4)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const current = instanceOf(state.log, 'inst-1')
  if (current === undefined) throw new Error('not projected')
  const claimed = claim(current, OKAFOR, current.version ?? 0, deps('op-3', 5))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  return apply(claimed.operation, state).log
}

/** The operations the route appended, in order. */
const appended: { type: string; actor: unknown; payload: Record<string, unknown> }[] = []

/** The identity provider calls the route made, as `METHOD path`. */
const directoryCalls: string[] = []

function sessionPool(grants: readonly Record<string, unknown>[], log = claimedLog()): Pool {
  const now = Date.now()
  const principals = new Set([ADMIN, OKAFOR])
  return {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith('insert into events')) {
          appended.push({
            type: String(values?.[1]),
            actor: values?.[3],
            payload: JSON.parse(String(values?.[4])) as Record<string, unknown>,
          })
          return { rows: [{ seq: String(log.length + appended.length) }] }
        }
        return { rows: [] }
      },
      release: () => undefined,
    }),
    query: (text: string, values?: unknown[]) => {
      if (text.includes('from sessions')) {
        return Promise.resolve({
          rows: [
            {
              id: 'session-1',
              principal_id: ADMIN,
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
        const id = String(values?.[0])
        return Promise.resolve({
          rows: principals.has(id) ? [{ id, display_name: id, email: null, groups: [] }] : [],
        })
      }
      if (text.includes('from grants')) return Promise.resolve({ rows: grants })
      if (text.includes('from instances') && text.includes('holder')) {
        return Promise.resolve({ rows: values?.[0] === OKAFOR ? [{ id: 'inst-1' }] : [] })
      }
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
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Pool
}

/** The identity provider: the admin token, one enabled user, and the disable. */
function stubDirectory(users: Readonly<Record<string, boolean>>): void {
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = new URL(url).pathname
    directoryCalls.push(`${method} ${path}`)
    if (path.endsWith('/protocol/openid-connect/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'admin-token' }), { status: 200 })
      )
    }
    const match = /\/admin\/realms\/[^/]+\/users\/([^/]+)$/.exec(path)
    if (match !== null) {
      const id = decodeURIComponent(match[1])
      if (!(id in users)) return Promise.resolve(new Response('not found', { status: 404 }))
      if (method === 'PUT') return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(
        new Response(JSON.stringify({ id, username: id, enabled: users[id], attributes: {} }), {
          status: 200,
        })
      )
    }
    return Promise.resolve(new Response('unexpected', { status: 500 }))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  appended.length = 0
  directoryCalls.length = 0
})

const cookie = `${defaultConfig.session.cookieName}=session-1`
const administrator = { principal: ADMIN, scopes: ['org.grants'], resource: 'org' }

async function deprovisionRequest(pool: Pool, id: string): Promise<Response> {
  const app = createApp(defaultConfig, pool)
  return app.request(`/api/v1/admin/users/${encodeURIComponent(id)}/deprovision`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': 'csrf-1' },
  })
}

test.fails('#267 ID-5 a deprovision disables the account, releases the held task with the reason and records the account', async () => {
  stubDirectory({ [OKAFOR]: true })
  const response = await deprovisionRequest(sessionPool([administrator]), OKAFOR)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    principal: OKAFOR,
    released: [{ instanceId: 'inst-1', step: 'advisor' }],
  })
  // The identity provider holds the account disabled (ID-6).
  expect(directoryCalls).toContain(`PUT /admin/realms/enform-local/users/${OKAFOR}`)
  // The release and the account record are on the log, attributed to Dana
  // (I14), the release with the reason (WF-5).
  expect(appended.map((operation) => operation.type)).toEqual([TASK_RELEASED, USER_DEPROVISIONED])
  expect(appended[0]).toMatchObject({
    actor: ADMIN,
    payload: {
      instanceId: 'inst-1',
      step: 'advisor',
      holder: OKAFOR,
      reason: `${OKAFOR} was deprovisioned`,
    },
  })
  expect(appended[1]).toMatchObject({
    actor: ADMIN,
    payload: { principal: OKAFOR, released: [{ instanceId: 'inst-1', step: 'advisor' }] },
  })
})

test.fails('#267 I8 a deprovision without org.grants answers 403 and touches neither the log nor the directory', async () => {
  stubDirectory({ [OKAFOR]: true })
  const response = await deprovisionRequest(sessionPool([]), OKAFOR)
  expect(response.status).toBe(403)
  expect(appended).toEqual([])
  expect(directoryCalls).toEqual([])
})

test.fails('#267 ID-4 a principal that neither the directory nor the log knows answers 404', async () => {
  stubDirectory({})
  const response = await deprovisionRequest(sessionPool([administrator]), 'user:nobody')
  expect(response.status).toBe(404)
  expect(((await response.json()) as { error: string }).error).toContain('user:nobody')
  expect(appended).toEqual([])
})

test.fails('#267 I1 a second deprovision of the same account appends nothing and says so', async () => {
  stubDirectory({ [OKAFOR]: false })
  const log = [
    ...claimedLog(),
    {
      seq: 6,
      operationId: 'op-4',
      type: USER_DEPROVISIONED,
      at: 6,
      actor: ADMIN,
      payload: { principal: OKAFOR, released: [] },
    },
  ]
  const response = await deprovisionRequest(sessionPool([administrator], log), OKAFOR)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    principal: OKAFOR,
    released: [],
    alreadyDeprovisioned: true,
  })
  expect(appended).toEqual([])
})
