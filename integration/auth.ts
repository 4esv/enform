import type { TestConfig } from './config.js'

// Issue #213, #220, ID-6, ADR 0012: the Keycloak credentials of the integration
// suite. The walking skeleton and the flow API both need the first
// administrator's direct-grant token and, for the authorization check, a second
// user without a grant. These helpers read the real identity provider; they do
// not touch the enform bootstrap.

/** One local-directory user that the test creates (ID-6). */
export type DirectoryUser = {
  readonly username: string
  readonly email: string
  readonly firstName: string
  readonly lastName: string
  readonly password: string
}

/** The signed-in principal, as `GET /api/v1/session` returns it. */
export type Session = {
  readonly principal: { readonly id: string; readonly displayName: string }
}

/** The Keycloak bootstrap administrator token, in the master realm. */
export async function keycloakAdminToken(config: TestConfig): Promise<string> {
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
export async function passwordToken(
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
export async function createUser(
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

/** Read the session behind one access token. */
export async function readSession(publicUrl: string, token: string): Promise<Session> {
  const response = await fetch(`${publicUrl}/api/v1/session`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return json<Session>(response, 'GET /api/v1/session')
}

/** Read one `access_token` from a token response, or name the failure. */
export async function accessToken(response: Response, what: string): Promise<string> {
  const body = await response.text()
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${body}`)
  const token = (JSON.parse(body) as { access_token?: string }).access_token
  if (token === undefined) throw new Error(`${what} returned no access_token: ${body}`)
  return token
}

/** Read one JSON response, or name the request that failed. */
export async function json<T>(response: Response, what: string): Promise<T> {
  const body = await response.text()
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${body}`)
  return JSON.parse(body) as T
}

/** The immutable subject claim of an access token (ID-4). */
export function subjectOf(token: string): string {
  const payload = token.split('.')[1]
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub?: string
  }
  if (claims.sub === undefined) throw new Error('the access token carries no sub claim')
  return claims.sub
}
