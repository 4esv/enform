// Issue #216, ID-1, ID-4, ID-5, ID-6, ADR 0005, ADR 0012: the Keycloak client.
// Keycloak is the only identity provider. Its built-in user store is the
// default directory, and the immutable principal id is the Keycloak subject
// (`sub`), never a name or an email address. enform stores no credentials; the
// administrator path calls the Keycloak Admin API with a dedicated credential.

import { randomInt } from 'node:crypto'
import {
  allowInsecureRequests,
  ClientSecretPost,
  type Configuration,
  discovery,
  fetchUserInfo,
  skipSubjectCheck,
} from 'openid-client'
import { type Config, issuerUrl } from './config.js'
import type { Principal } from './db.js'

/** One user to create in the local directory (ID-6, DE-1, ADR 0012). */
export type CreateDirectoryUserInput = {
  readonly email: string
  readonly displayName: string
}

/** The immutable id of a created user and its one-time password (ID-6). */
export type CreatedDirectoryUser = {
  readonly id: string
  readonly temporaryPassword: string
}

/** The directory already holds the email address, so no second user is created (ID-6). */
export class DirectoryUserExistsError extends Error {
  readonly email: string

  constructor(email: string) {
    super(`the directory already holds ${email}`)
    this.name = 'DirectoryUserExistsError'
    this.email = email
  }
}

/** One user of the built-in directory, as the admin API lists it (ID-6). */
export type DirectoryUser = {
  readonly id: string
  readonly displayName: string
  readonly email: string
  readonly status: 'invited' | 'active' | 'disabled'
  readonly groups: readonly string[]
}

/** One user to create or update in the local directory (ID-6). */
export type AdministratorInput = {
  readonly email: string
  readonly password: string
  readonly firstName?: string
  readonly lastName?: string
}

/** A Keycloak user representation, narrowed to the fields this slice reads. */
type KeycloakUser = {
  readonly id?: string
  readonly username?: string
  readonly email?: string
  readonly firstName?: string
  readonly lastName?: string
  readonly enabled?: boolean
  readonly emailVerified?: boolean
  readonly requiredActions?: readonly string[]
  readonly credentials?: readonly Record<string, unknown>[]
}

/** The discovery of one realm, cached per issuer (ADR 0012). */
const configurations = new Map<string, Promise<Configuration>>()

/** The OIDC configuration of the configured realm (ADR 0012). */
export function oidcConfiguration(config: Config): Promise<Configuration> {
  const issuer = issuerUrl(config)
  const cached = configurations.get(issuer)
  if (cached !== undefined) return cached
  const pending = discovery(
    new URL(issuer),
    config.keycloak.clientId,
    undefined,
    ClientSecretPost(config.keycloak.clientSecret),
    { execute: [allowInsecureRequests] }
  ).catch((error: unknown) => {
    configurations.delete(issuer)
    throw error
  })
  configurations.set(issuer, pending)
  return pending
}

/**
 * Validate a bearer token through the identity provider's userinfo endpoint
 * and return the principal it names (ID-4, ADR 0012). A bad or expired token
 * makes the provider answer 401, which the caller turns into a 401.
 */
export async function principalFromToken(config: Config, token: string): Promise<Principal> {
  const configuration = await oidcConfiguration(config)
  const info = (await fetchUserInfo(configuration, token, skipSubjectCheck)) as Record<
    string,
    unknown
  >
  const id = stringClaim(info, 'sub')
  if (id === undefined) throw new Error('the access token carries no sub claim')
  const groups = groupIds(info.groups)
  const email = stringClaim(info, 'email')
  return {
    id,
    displayName: displayNameOf(info) ?? email ?? id,
    ...(email === undefined ? {} : { email }),
    groups,
  }
}

/** The absolute expiry of a JWT, in milliseconds, when it carries `exp`. */
export function tokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** The Keycloak bootstrap administrator token in the master realm (ID-6). */
export async function adminToken(config: Config): Promise<string> {
  const response = await fetch(`${baseUrl(config)}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: config.keycloak.adminUser,
      password: config.keycloak.adminPassword,
    }),
  })
  const body = await response.text()
  if (!response.ok)
    throw new Error(`keycloak: the administrator sign-in failed: ${response.status} ${body}`)
  const parsed = JSON.parse(body) as { access_token?: unknown }
  if (typeof parsed.access_token !== 'string') {
    throw new Error('keycloak: the administrator sign-in returned no access token')
  }
  return parsed.access_token
}

/**
 * The first and last name of a display name (ID-4): the first token is the
 * first name and the rest is the last name, or the whole display name is the
 * first name when it holds one token.
 */
function nameParts(displayName: string): { firstName: string; lastName?: string } {
  const parts = displayName
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
  const firstName = parts[0] ?? displayName.trim()
  const rest = parts.slice(1)
  return rest.length === 0 ? { firstName } : { firstName, lastName: rest.join(' ') }
}

/** The alphabet of a generated password, without look-alike characters (ID-6). */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/**
 * A generated strong password (ID-6): 24 characters with an upper case letter,
 * a lower case letter, a digit and a symbol, so a realm's default password
 * policy accepts it. The administrator sees it once; the server logs it never.
 */
function temporaryPasswordOf(): string {
  const body = Array.from(
    { length: 20 },
    () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  ).join('')
  return `Aa2!${body}`
}

/**
 * Create or update the first administrator and set the password (DE-1, ID-6).
 * A second run finds the same user by username or email, so it creates no
 * duplicate.
 */
export async function ensureAdministrator(
  config: Config,
  input: AdministratorInput
): Promise<string> {
  const token = await adminToken(config)
  const firstName = input.firstName ?? 'Enform'
  const lastName = input.lastName ?? 'Administrator'
  const existing = await findUser(config, token, input.email)
  const representation = {
    username: input.email,
    email: input.email,
    firstName,
    lastName,
    enabled: true,
    emailVerified: true,
  }
  const id =
    existing?.id ??
    (await createUser(config, token, {
      ...representation,
      credentials: [{ type: 'password', value: input.password, temporary: false }],
    }))
  if (existing !== undefined) {
    await updateUser(config, token, id, { id, ...representation })
    await resetPassword(config, token, id, input.password)
  }
  return id
}

/**
 * Create one user in the local realm with a generated temporary password
 * (ID-6, DE-1, ADR 0012). The user is enabled and email-verified with no
 * required action, so the password signs the user in immediately. The
 * password is returned once to the caller and enform stores it never. A
 * directory that already holds the email address throws
 * `DirectoryUserExistsError`. An invite email is not sent: the mail transport
 * arrives with SE-1 and SE-2.
 */
export async function createDirectoryUser(
  config: Config,
  input: CreateDirectoryUserInput
): Promise<CreatedDirectoryUser> {
  const token = await adminToken(config)
  if ((await findUser(config, token, input.email)) !== undefined) {
    throw new DirectoryUserExistsError(input.email)
  }
  const temporaryPassword = temporaryPasswordOf()
  const name = nameParts(input.displayName)
  const id = await createUser(config, token, {
    username: input.email,
    email: input.email,
    ...name,
    enabled: true,
    emailVerified: true,
    requiredActions: [],
    credentials: [{ type: 'password', value: temporaryPassword, temporary: false }],
  })
  return { id, temporaryPassword }
}

/**
 * Delete one user from the local realm through the Admin API (DE-4). A user
 * that is already gone is success, so clearing a seed twice is harmless.
 */
export async function deleteDirectoryUser(config: Config, id: string): Promise<void> {
  const token = await adminToken(config)
  const response = await fetch(`${adminBase(config)}/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `keycloak: deleting the user ${id} failed: ${response.status} ${await response.text()}`
    )
  }
}

/** Every user of the configured realm, for the administrator surface (ID-6). */
export async function listDirectoryUsers(config: Config): Promise<readonly DirectoryUser[]> {
  const token = await adminToken(config)
  const response = await fetch(`${adminBase(config)}/users?max=1000`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await response.text()
  if (!response.ok)
    throw new Error(`keycloak: listing the directory failed: ${response.status} ${body}`)
  const users = JSON.parse(body) as KeycloakUser[]
  return users.map((user) => ({
    id: user.id ?? '',
    displayName:
      [user.firstName, user.lastName]
        .filter((part) => part !== undefined && part !== '')
        .join(' ') ||
      user.username ||
      user.email ||
      user.id ||
      '',
    email: user.email ?? '',
    status:
      user.enabled === false
        ? 'disabled'
        : (user.requiredActions ?? []).includes('UPDATE_PASSWORD')
          ? 'invited'
          : 'active',
    groups: [],
  }))
}

/** End the identity provider session that a refresh token names (ID-5). */
export async function endIdpSession(config: Config, refreshToken: string): Promise<void> {
  try {
    await fetch(`${issuerUrl(config)}/protocol/openid-connect/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.keycloak.clientId,
        client_secret: config.keycloak.clientSecret,
        refresh_token: refreshToken,
      }),
    })
  } catch {
    // The session row is already revoked. A provider that is unreachable
    // cannot keep the local cookie authenticating, so the local revoke stands.
  }
}

/** Find one user by exact username, then by exact email (ID-6). */
async function findUser(
  config: Config,
  token: string,
  email: string
): Promise<KeycloakUser | undefined> {
  const byUsername = await searchUsers(config, token, 'username', email)
  if (byUsername !== undefined) return byUsername
  return searchUsers(config, token, 'email', email)
}

/** Search the realm for one exact field value. */
async function searchUsers(
  config: Config,
  token: string,
  field: 'username' | 'email',
  value: string
): Promise<KeycloakUser | undefined> {
  const query = new URLSearchParams({ [field]: value, exact: 'true' })
  const response = await fetch(`${adminBase(config)}/users?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`keycloak: the user lookup failed: ${response.status} ${body}`)
  const users = JSON.parse(body) as KeycloakUser[]
  return users[0]
}

/** Create one directory user and return its immutable id. */
async function createUser(
  config: Config,
  token: string,
  representation: Record<string, unknown>
): Promise<string> {
  const response = await fetch(`${adminBase(config)}/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(representation),
  })
  const body = await response.text()
  if (response.status === 409) {
    const email = typeof representation.email === 'string' ? representation.email : ''
    throw new DirectoryUserExistsError(email)
  }
  if (response.status !== 201) {
    throw new Error(`keycloak: creating the user failed: ${response.status} ${body}`)
  }
  const location = response.headers.get('location')
  const id = location?.split('/').pop()
  if (id !== undefined && id !== '') return id
  const email = representation.email
  if (typeof email !== 'string') throw new Error('keycloak: the created user has no email')
  const found = await findUser(config, token, email)
  if (found?.id === undefined) throw new Error('keycloak: the created user has no id')
  return found.id
}

/** Update one directory user. */
async function updateUser(
  config: Config,
  token: string,
  id: string,
  representation: Record<string, unknown>
): Promise<void> {
  const response = await fetch(`${adminBase(config)}/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(representation),
  })
  if (!response.ok) {
    throw new Error(
      `keycloak: updating the administrator failed: ${response.status} ${await response.text()}`
    )
  }
}

/** Set a non-temporary password on one directory user. */
async function resetPassword(
  config: Config,
  token: string,
  id: string,
  password: string
): Promise<void> {
  const response = await fetch(
    `${adminBase(config)}/users/${encodeURIComponent(id)}/reset-password`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'password', value: password, temporary: false }),
    }
  )
  if (!response.ok) {
    throw new Error(
      `keycloak: setting the administrator password failed: ${response.status} ${await response.text()}`
    )
  }
}

/** The base URL without a trailing slash. */
function baseUrl(config: Config): string {
  return config.keycloak.url.replace(/\/+$/, '')
}

/** The realm admin API base. */
function adminBase(config: Config): string {
  return `${baseUrl(config)}/admin/realms/${encodeURIComponent(config.keycloak.realm)}`
}

/** The display name that the provider reports, if any (ID-4). */
function displayNameOf(claims: Record<string, unknown>): string | undefined {
  const name = stringClaim(claims, 'name')
  if (name !== undefined) return name
  const given = stringClaim(claims, 'given_name')
  const family = stringClaim(claims, 'family_name')
  const joined = [given, family].filter((part) => part !== undefined).join(' ')
  if (joined !== '') return joined
  return stringClaim(claims, 'preferred_username')
}

/** One string claim, or undefined. */
function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The group ids of a `groups` claim (#218, ID-4, ID-5). Keycloak sends a JSON
 * array when a user belongs to several groups and a single string when it
 * belongs to one, so both shapes are valid. The result is deduplicated and
 * empty strings are dropped; any other shape contributes nothing.
 */
export function groupIds(value: unknown): readonly string[] {
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const ids = entries.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return [...new Set(ids)]
}
