import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #224, ADR 0012: the browser authenticates with the session cookie. A
// request that still carries an empty `Authorization: Bearer ` header, which
// the generated client used to send for an empty token, must fall through to
// the cookie instead of failing as a bad bearer credential.

/** A pool that answers the three reads of one valid cookie session. */
function sessionPool(grants: readonly Record<string, unknown>[] = []): Pool {
  const now = Date.now()
  return {
    query: (text: string) => {
      if (text.includes('from sessions')) {
        return Promise.resolve({
          rows: [
            {
              id: 'session-1',
              principal_id: 'user-1',
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
          rows: [{ id: 'user-1', display_name: 'Ana', email: null, groups: [] }],
        })
      }
      if (text.includes('from grants')) return Promise.resolve({ rows: grants })
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Pool
}

const cookie = `${defaultConfig.session.cookieName}=session-1`

test('#224 an empty bearer header falls through to the session cookie', async () => {
  const app = createApp(defaultConfig, sessionPool())
  const response = await app.request('/api/v1/session', {
    headers: { authorization: 'Bearer ', cookie },
  })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  expect(JSON.parse(body)).toMatchObject({
    principal: { id: 'user-1', displayName: 'Ana' },
    csrfToken: 'csrf-1',
  })
})

test('#224 the cookie still authenticates when no Authorization header is sent', async () => {
  const app = createApp(defaultConfig, sessionPool())
  const response = await app.request('/api/v1/session', { headers: { cookie } })
  expect(response.status, await response.text()).toBe(200)
})

test('#224 an empty bearer header without a cookie answers 401', async () => {
  const app = createApp(defaultConfig, sessionPool())
  const response = await app.request('/api/v1/session', {
    headers: { authorization: 'Bearer ' },
  })
  expect(response.status).toBe(401)
})

test('#224 a malformed grant answers 400 and appends nothing', async () => {
  const app = createApp(defaultConfig, sessionPool())
  const response = await app.request('/api/v1/operations', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ',
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': 'csrf-1',
    },
    body: JSON.stringify({
      id: 'grant-1',
      type: 'config.grant.changed@1',
      at: 1,
      actor: 'ignored',
      payload: { principal: 'user-1', scopes: 'step.outcome:approve', resource: 'org' },
    }),
  })
  expect(response.status, await response.text()).toBe(400)
})

test('#224 a grant without a grant scope answers 403', async () => {
  const app = createApp(defaultConfig, sessionPool())
  const response = await app.request('/api/v1/operations', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ',
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': 'csrf-1',
    },
    body: JSON.stringify({
      id: 'grant-2',
      type: 'config.grant.changed@1',
      at: 1,
      actor: 'ignored',
      payload: {
        principal: 'user-1',
        scopes: ['step.outcome:approve'],
        resource: 'flow:demo/step:request',
      },
    }),
  })
  expect(response.status, await response.text()).toBe(403)
})

/** The org grant that an administrator holds on the organization (ID-6). */
const administratorGrants = [{ principal: 'user-1', resource: 'org', scopes: ['org.grants'] }]

/** Post one body to `POST /api/v1/admin/users` as the cookie session. */
async function createUserRequest(
  app: ReturnType<typeof createApp>,
  body: unknown
): Promise<Response> {
  return app.request('/api/v1/admin/users', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ',
      cookie,
      'content-type': 'application/json',
      'x-csrf-token': 'csrf-1',
    },
    body: JSON.stringify(body),
  })
}

test('#228 a malformed create-user body answers 400 and creates nothing', async () => {
  const app = createApp(defaultConfig, sessionPool(administratorGrants))
  const response = await createUserRequest(app, {
    email: 'not-an-email',
    displayName: 'Ada',
    sendInvite: false,
  })
  expect(response.status, await response.text()).toBe(400)
})

test('#228 a create-user request without org.grants answers 403', async () => {
  const app = createApp(defaultConfig, sessionPool())
  const response = await createUserRequest(app, {
    email: 'ada@test.local',
    displayName: 'Ada Lovelace',
    sendInvite: false,
  })
  expect(response.status, await response.text()).toBe(403)
})

test('#228 an invite without a mail transport answers 409 mail-not-configured', async () => {
  const app = createApp(defaultConfig, sessionPool(administratorGrants))
  const response = await createUserRequest(app, {
    email: 'ada@test.local',
    displayName: 'Ada Lovelace',
    sendInvite: true,
  })
  const body = await response.text()
  expect(response.status, body).toBe(409)
  expect(JSON.parse(body)).toMatchObject({ code: 'mail-not-configured' })
})

test('#228 a create-user request without the CSRF token answers 403', async () => {
  const app = createApp(defaultConfig, sessionPool(administratorGrants))
  const response = await app.request('/api/v1/admin/users', {
    method: 'POST',
    headers: { authorization: 'Bearer ', cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'ada@test.local',
      displayName: 'Ada Lovelace',
      sendInvite: false,
    }),
  })
  expect(response.status, await response.text()).toBe(403)
})
