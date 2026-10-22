import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #224, ADR 0012: the browser authenticates with the session cookie. A
// request that still carries an empty `Authorization: Bearer ` header, which
// the generated client used to send for an empty token, must fall through to
// the cookie instead of failing as a bad bearer credential.

/** A pool that answers the three reads of one valid cookie session. */
function sessionPool(): Pool {
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
