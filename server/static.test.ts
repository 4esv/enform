import type { Pool } from 'pg'
import { expect, test } from 'vitest'
import { defaultConfig } from './config.js'
import { createApp } from './http.js'

// Issue #224, ADR 0009, DX-4: the release server serves the app at the site
// root and the generated client beside it, with a `.ts` module transpiled to
// the `.js` a browser runs. The API and the operational routes keep their own
// paths.

/** A pool that answers no query: these routes never read the store. */
const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool

test('#224 the server serves the app and the generated client, and not the API', async () => {
  const app = createApp(defaultConfig, pool)

  const index = await app.request('/')
  expect(index.status).toBe(200)
  expect(index.headers.get('content-type')).toContain('text/html')

  const appModule = await app.request('/app/app.js')
  expect(appModule.status).toBe(200)
  expect(appModule.headers.get('content-type')).toContain('text/javascript')
  expect(await appModule.text(), 'the type annotations are stripped').not.toContain(
    'export interface'
  )

  const client = await app.request('/client/client.js')
  expect(client.status).toBe(200)
  expect(await client.text()).toContain('export function setClient')

  const health = await app.request('/healthz')
  expect(health.status, 'the interface never shadows the readiness surface').toBe(200)

  const session = await app.request('/api/v1/session')
  expect(session.status, 'the interface never shadows the API').toBe(401)

  const missing = await app.request('/app/missing.js')
  expect(missing.status).toBe(404)
})
