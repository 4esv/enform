import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Issue #258, DX-3, S01, ID-6, ADR 0012: `enform login`. The CLI signs in
// through the identity provider's OAuth 2.0 device authorization flow (RFC
// 8628): it asks the enform server which provider and client to use, requests
// a device code, shows the person the verification URL and the user code,
// polls the token endpoint until the person approved, and keeps the tokens.
// A scripted sign-in takes a username and a password of the local directory
// (ID-6), for automation and the tests. The credential is stored per server
// with its refresh token, and refreshed before a command uses it. Every
// source (fetch, the clock, the sleep, the output) is injected, so the flow
// is deterministic in a test (I6).

/** The credential of one server: the tokens, when the access token expires, and where to refresh it. */
export type Credential = {
  readonly accessToken: string
  readonly refreshToken?: string
  /** The expiry of the access token, in milliseconds since the epoch. */
  readonly expiresAt: number
  readonly tokenEndpoint: string
  readonly clientId: string
}

/** What the enform server tells a CLI about its identity provider (`GET /api/v1/auth/cli`). */
export type CliAuth = {
  readonly clientId: string
  readonly deviceAuthorizationEndpoint: string
  readonly tokenEndpoint: string
}

/** The injected sources of a sign-in (I6). */
type Sources = {
  readonly fetch: typeof fetch
  readonly now: () => number
}

/** The environment variable that names the credential file; absent means the user's config directory. */
export const CREDENTIALS_ENV = 'ENFORM_CREDENTIALS'

/** The credential file: `$ENFORM_CREDENTIALS`, else `$XDG_CONFIG_HOME/enform/credentials.json`, else `~/.config/enform/credentials.json`. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[CREDENTIALS_ENV]
  if (named !== undefined && named !== '') return named
  const configHome = env.XDG_CONFIG_HOME
  const base =
    configHome !== undefined && configHome !== '' ? configHome : join(homedir(), '.config')
  return join(base, 'enform', 'credentials.json')
}

/** The stored credentials: one per server URL. */
type CredentialFile = Record<string, Credential>

function readFile(path: string): CredentialFile {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`login: ${path} is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`login: ${path} does not hold credentials`)
  }
  return parsed as CredentialFile
}

/** The credential stored for one server, or undefined when the person has not signed in there. */
export function readCredential(path: string, server: string): Credential | undefined {
  const entry = readFile(path)[normalizeServer(server)]
  return entry !== undefined && typeof entry.accessToken === 'string' ? entry : undefined
}

/** Store the credential of one server; the file is readable by its owner only. */
export function writeCredential(path: string, server: string, credential: Credential): void {
  const file = { ...readFile(path), [normalizeServer(server)]: credential }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

/** Forget the credential of one server (`enform logout`). */
export function removeCredential(path: string, server: string): void {
  const file = readFile(path)
  delete file[normalizeServer(server)]
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

/** The entry of the credential file that remembers the server of the last sign-in. */
const DEFAULT_SERVER_KEY = '$default'

/** Remember the server of the last sign-in, so a later command needs no `--server`. */
export function rememberServer(path: string, server: string): void {
  const file = readFile(path)
  const next = { ...file, [DEFAULT_SERVER_KEY]: { server: normalizeServer(server) } }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
}

/** The server of the last sign-in, or undefined when nobody signed in on this machine. */
export function rememberedServer(path: string): string | undefined {
  const entry = readFile(path)[DEFAULT_SERVER_KEY] as unknown
  if (typeof entry !== 'object' || entry === null) return undefined
  const server = (entry as { readonly server?: unknown }).server
  return typeof server === 'string' && server !== '' ? server : undefined
}

/** A server URL without its trailing slash, so one server has one entry. */
export function normalizeServer(server: string): string {
  return server.replace(/\/+$/, '')
}

/** Ask the enform server which identity provider and client the CLI signs in with. */
export async function cliAuth(server: string, fetchImpl: typeof fetch): Promise<CliAuth> {
  const response = await fetchImpl(`${normalizeServer(server)}/api/v1/auth/cli`)
  if (!response.ok) {
    throw new Error(`login: ${server} did not describe its sign-in (HTTP ${response.status})`)
  }
  const body = (await response.json()) as Partial<CliAuth>
  if (
    typeof body.clientId !== 'string' ||
    typeof body.deviceAuthorizationEndpoint !== 'string' ||
    typeof body.tokenEndpoint !== 'string'
  ) {
    throw new Error(`login: ${server} answered an incomplete sign-in description`)
  }
  return {
    clientId: body.clientId,
    deviceAuthorizationEndpoint: body.deviceAuthorizationEndpoint,
    tokenEndpoint: body.tokenEndpoint,
  }
}

/** The token endpoint's answer, as RFC 6749 shapes it. */
type TokenResponse = {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
  readonly error_description?: string
}

/** Post one form to the token endpoint and read its answer. */
async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: TokenResponse }> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
  const body = (await response.json().catch(() => ({}))) as TokenResponse
  return { status: response.status, body }
}

/** The credential that a token answer carries. */
function credentialOf(
  body: TokenResponse,
  tokenEndpoint: string,
  clientId: string,
  now: number
): Credential {
  if (typeof body.access_token !== 'string') {
    throw new Error('login: the identity provider answered no access token')
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    expiresAt: now + expiresIn * 1000,
    tokenEndpoint,
    clientId,
  }
}

/** The device authorization answer (RFC 8628 section 3.2). */
type DeviceResponse = {
  readonly device_code?: string
  readonly user_code?: string
  readonly verification_uri?: string
  readonly verification_uri_complete?: string
  readonly expires_in?: number
  readonly interval?: number
  readonly error?: string
}

/**
 * Sign in through the device authorization flow (S01, SSO device flow). The
 * person opens the verification URL, confirms the user code and signs in at
 * the identity provider; the CLI polls the token endpoint at the interval
 * the provider gave, slows down when asked, and stops when the code expired
 * or the person denied the sign-in.
 */
export async function deviceLogin(options: {
  readonly server: string
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly write: (line: string) => void
}): Promise<Credential> {
  const auth = await cliAuth(options.server, options.fetch)
  const started = await options.fetch(auth.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: auth.clientId, scope: 'openid profile email' }),
  })
  const device = (await started.json().catch(() => ({}))) as DeviceResponse
  if (
    !started.ok ||
    typeof device.device_code !== 'string' ||
    typeof device.user_code !== 'string' ||
    typeof device.verification_uri !== 'string'
  ) {
    throw new Error(
      `login: the identity provider refused the device sign-in (${device.error ?? `HTTP ${started.status}`})`
    )
  }
  const url = device.verification_uri_complete ?? device.verification_uri
  options.write(`Open ${url}`)
  options.write(`and confirm the code ${device.user_code} to sign in.`)
  let interval = Math.max(0, (device.interval ?? 5) * 1000)
  const deadline = options.now() + (device.expires_in ?? 600) * 1000
  while (options.now() <= deadline) {
    await options.sleep(interval)
    const { status, body } = await tokenRequest(
      auth.tokenEndpoint,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: auth.clientId,
        device_code: device.device_code,
      },
      options.fetch
    )
    if (status === 200) return credentialOf(body, auth.tokenEndpoint, auth.clientId, options.now())
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (body.error === 'access_denied') throw new Error('login: the sign-in was denied')
    if (body.error === 'expired_token') break
    throw new Error(`login: the sign-in failed (${body.error_description ?? body.error ?? status})`)
  }
  throw new Error(
    'login: the code expired before the sign-in was confirmed; run enform login again'
  )
}

/** Sign in with a username and a password of the local directory (ID-6): for automation and the tests. */
export async function passwordLogin(
  options: Sources & {
    readonly server: string
    readonly username: string
    readonly password: string
  }
): Promise<Credential> {
  const auth = await cliAuth(options.server, options.fetch)
  const { status, body } = await tokenRequest(
    auth.tokenEndpoint,
    {
      grant_type: 'password',
      client_id: auth.clientId,
      username: options.username,
      password: options.password,
      scope: 'openid profile email',
    },
    options.fetch
  )
  if (status !== 200) {
    throw new Error(
      `login: the sign-in was refused (${body.error_description ?? body.error ?? status})`
    )
  }
  return credentialOf(body, auth.tokenEndpoint, auth.clientId, options.now())
}

/** How long before the expiry a credential counts as stale, so a command in flight does not outlive it. */
const EXPIRY_MARGIN_MS = 10_000

/**
 * The credential a command uses (ADR 0012): the stored one while it is
 * fresh, else the one its refresh token obtains. A credential that cannot be
 * refreshed asks the person to sign in again.
 */
export async function freshCredential(
  credential: Credential,
  sources: Sources
): Promise<Credential> {
  if (credential.expiresAt - EXPIRY_MARGIN_MS > sources.now()) return credential
  if (credential.refreshToken === undefined) {
    throw new Error('login: the sign-in expired; run enform login again')
  }
  const { status, body } = await tokenRequest(
    credential.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
    },
    sources.fetch
  )
  if (status !== 200) {
    throw new Error('login: the sign-in expired and could not be refreshed; run enform login again')
  }
  return credentialOf(body, credential.tokenEndpoint, credential.clientId, sources.now())
}
