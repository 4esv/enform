import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #213, ID-6, DE-1, DE-3, ADR 0012, ADR 0013: the walking skeleton
// against a real PostgreSQL and a real Keycloak. `enform init` writes the
// configuration, creates the database, migrates it, creates the first
// administrator and serves the configured URL; a local directory user then
// signs in without federation. The implementation lane flips the expected
// failures (MVP.md 11.1).

const ADMIN_EMAIL = 'admin@test.local'
const ADMIN_PASSWORD = 'admin-test-password'

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly service: EnformProcess
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-foundation-'))
    const databaseUrl = databaseUrlForRun(config.databaseUrl)
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const configPath = join(dir, 'enform.toml')

    const service = await startEnform(
      [
        'init',
        '--config',
        configPath,
        '--database-url',
        databaseUrl,
        '--public-url',
        publicUrl,
        '--admin-email',
        ADMIN_EMAIL,
        '--admin-password',
        ADMIN_PASSWORD,
        '--keycloak-url',
        config.keycloakUrl,
        '--keycloak-realm',
        config.realm,
        '--keycloak-admin-user',
        config.keycloakAdmin,
        '--keycloak-admin-password',
        config.keycloakAdminPassword,
        '--no-open',
      ],
      publicUrl
    )

    setup = { config, dir, configPath, databaseUrl, publicUrl, service }
  } catch (error) {
    setupError = error
  }
}, 120_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

/** The shared setup, or the reason that `enform init` did not produce it. */
function requireSetup(): Setup {
  if (setup === undefined) {
    throw setupError ?? new Error('integration: the shared setup did not run')
  }
  return setup
}

test('DE-1 enform init creates the database, migrates, creates the first administrator and serves the configured URL', async () => {
  const { config, configPath, databaseUrl, publicUrl } = requireSetup()

  expect(existsSync(configPath), `${configPath} exists`).toBe(true)
  const written = readFileSync(configPath, 'utf8')
  expect(written, 'the configuration names the public URL').toContain(publicUrl)
  expect(written, 'the configuration names the database').toContain(databaseUrl)

  const name = new URL(databaseUrl).pathname.replace(/^\//, '')
  expect(queryDatabase(databaseUrl, 'select current_database()')).toEqual([name])
  const tables = queryDatabase(
    databaseUrl,
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
  )
  expect(tables, 'the migration created the event log').toContain('events')
  expect(tables, 'the migration recorded itself').toContain('schema_migrations')

  const adminToken = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  const session = await readSession(publicUrl, adminToken)
  expect(session.principal.id, 'the principal is the Keycloak subject').toBe(subjectOf(adminToken))

  const ready = await fetch(`${publicUrl}/readyz`)
  expect(ready.status, await ready.text()).toBe(200)
  const version = await fetch(`${publicUrl}/version`)
  const body = await version.text()
  expect(version.status, body).toBe(200)
  expect(body, 'the version names enform').toMatch(/\benform\b/i)
  expect(body, 'the version names a version number').toMatch(/\b\d+\.\d+\.\d+\b/)
})

test('ID-6 the built-in directory creates a local user who signs in without federation', async () => {
  const { config, publicUrl } = requireSetup()
  const adminToken = await keycloakAdminToken(config)
  const suffix = randomUUID().slice(0, 8)
  const user = {
    username: `ada-${suffix}`,
    email: `ada-${suffix}@test.local`,
    firstName: 'Ada',
    lastName: 'Lovelace',
    password: 'ada-test-password',
  }

  const createdId = await createUser(config, adminToken, user)
  const token = await passwordToken(config, user.username, user.password)
  const session = await readSession(publicUrl, token)
  expect(session.principal.id, 'the principal is the Keycloak subject').toBe(subjectOf(token))
  expect(session.principal.id, 'the principal is the created user').toBe(createdId)
  expect(session.principal.displayName, 'the display name is the user name').toBe(
    `${user.firstName} ${user.lastName}`
  )

  const admin = await passwordToken(config, ADMIN_EMAIL, ADMIN_PASSWORD)
  const response = await fetch(`${publicUrl}/api/v1/admin/users`, {
    headers: { authorization: `Bearer ${admin}` },
  })
  const users = await json<Array<{ id: string; email: string }>>(
    response,
    'GET /api/v1/admin/users'
  )
  expect(
    users.some((entry) => entry.id === createdId && entry.email === user.email),
    'the created user is listed'
  ).toBe(true)
})

type DirectoryUser = {
  readonly username: string
  readonly email: string
  readonly firstName: string
  readonly lastName: string
  readonly password: string
}

/** The Keycloak bootstrap administrator token, in the master realm. */
async function keycloakAdminToken(config: TestConfig): Promise<string> {
  const response = await fetch(
    `${config.keycloakUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: config.keycloakAdmin,
        password: config.keycloakAdminPassword,
      }),
    }
  )
  return accessToken(response, 'the Keycloak administrator sign-in')
}

/** A direct-grant access token from the enform realm, for the CLI credential. */
async function passwordToken(
  config: TestConfig,
  username: string,
  password: string
): Promise<string> {
  const realm = encodeURIComponent(config.realm)
  const response = await fetch(
    `${config.keycloakUrl}/realms/${realm}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        username,
        password,
        scope: 'openid profile email',
      }),
    }
  )
  return accessToken(response, `the direct grant for ${username}`)
}

/** Create one user in the local realm through the Keycloak Admin API (ID-6). */
async function createUser(
  config: TestConfig,
  adminToken: string,
  user: DirectoryUser
): Promise<string> {
  const realm = encodeURIComponent(config.realm)
  const headers = {
    authorization: `Bearer ${adminToken}`,
    'content-type': 'application/json',
  }
  const response = await fetch(`${config.keycloakUrl}/admin/realms/${realm}/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: user.password, temporary: false }],
    }),
  })
  const body = await response.text()
  if (response.status !== 201) {
    throw new Error(`creating ${user.username} failed: ${response.status} ${body}`)
  }
  const location = response.headers.get('location')
  const id = location?.split('/').pop()
  if (id !== undefined && id !== '') return id

  const lookup = await fetch(
    `${config.keycloakUrl}/admin/realms/${realm}/users?username=${encodeURIComponent(user.username)}&exact=true`,
    { headers }
  )
  const found = await json<Array<{ id: string }>>(lookup, `reading ${user.username} back`)
  const created = found[0]?.id
  if (created === undefined) throw new Error(`Keycloak did not return the id of ${user.username}`)
  return created
}

type Session = {
  readonly principal: { readonly id: string; readonly displayName: string }
}

async function readSession(publicUrl: string, token: string): Promise<Session> {
  const response = await fetch(`${publicUrl}/api/v1/session`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return json<Session>(response, 'GET /api/v1/session')
}

async function accessToken(response: Response, what: string): Promise<string> {
  const body = await response.text()
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${body}`)
  const token = (JSON.parse(body) as { access_token?: string }).access_token
  if (token === undefined) throw new Error(`${what} returned no access_token: ${body}`)
  return token
}

async function json<T>(response: Response, what: string): Promise<T> {
  const body = await response.text()
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${body}`)
  return JSON.parse(body) as T
}

/** The immutable subject claim of an access token (ID-4). */
function subjectOf(token: string): string {
  const payload = token.split('.')[1]
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub?: string
  }
  if (claims.sub === undefined) throw new Error('the access token carries no sub claim')
  return claims.sub
}
