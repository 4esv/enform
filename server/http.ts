// Issue #216, DE-1, DE-3, ID-4, ID-5, ID-6, ADR 0011, ADR 0012: the HTTP
// server. It answers the liveness, readiness and version surfaces of DE-3 and
// the session and sign-in surfaces of ADR 0012. The browser authenticates with
// the server-side session cookie and the CLI with a bearer token; both map to
// one principal and one session row. A path that this slice does not serve
// answers 404, and the PR says which ones.

import { createHash } from 'node:crypto'
import { serve } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client'
import type { Pool } from 'pg'
import { authorize } from '../engine/authorize.js'
import { type Config, issuerUrl, listenAddress } from './config.js'
import { decryptToken, encryptToken, validEncryptionKey } from './crypto.js'
import {
  createBrowserSession,
  createOidcAttempt,
  createPool,
  grantsOfPrincipal,
  type Principal,
  principalById,
  revokeSession,
  type SessionRow,
  sessionById,
  takeOidcAttempt,
  touchSession,
  upsertBearerSession,
  upsertPrincipal,
} from './db.js'
import {
  endIdpSession,
  groupIds,
  listDirectoryUsers,
  oidcConfiguration,
  principalFromToken,
  tokenExpiry,
} from './keycloak.js'
import { versionLine } from './version.js'

/** The running HTTP server and the way to drain it (DE-3). */
export type ServedHttp = {
  readonly port: number
  readonly close: () => Promise<void>
}

/** One authenticated request: the principal and the session row behind it. */
type Auth =
  | { readonly kind: 'bearer'; readonly principal: Principal; readonly session: SessionRow }
  | { readonly kind: 'cookie'; readonly principal: Principal; readonly session: SessionRow }

/** Build the HTTP application for one configuration and one pool. */
export function createApp(config: Config, pool: Pool): Hono {
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  app.get('/readyz', async (c) => {
    try {
      await pool.query('select 1')
      await oidcConfiguration(config)
      return c.json({ status: 'ready' })
    } catch (error) {
      return c.json({ status: 'not ready', error: messageOf(error) }, 503)
    }
  })

  app.get('/version', (c) => c.text(versionLine()))

  app.get('/api/v1/session', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    return c.json({
      principal: auth.principal,
      expiresAt: auth.session.expiresAt,
      csrfToken: auth.session.csrfToken,
    })
  })

  app.post('/api/v1/auth/logout', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (auth.kind === 'cookie' && c.req.header('x-csrf-token') !== auth.session.csrfToken) {
      return c.json({ error: 'the CSRF token is missing or invalid' }, 403)
    }
    const revoked = await revokeSession(pool, auth.session.id, Date.now())
    deleteCookie(c, config.session.cookieName, { path: '/' })
    const refreshToken = decryptStoredRefreshToken(config, revoked?.refreshToken)
    if (refreshToken !== undefined) await endIdpSession(config, refreshToken)
    return c.body(null, 204)
  })

  app.get('/api/v1/auth/login', async (c) => {
    const state = randomState()
    const codeVerifier = randomPKCECodeVerifier()
    const challenge = await calculatePKCECodeChallenge(codeVerifier)
    const now = Date.now()
    const returnTo = safeReturnTo(c.req.query('returnTo'))
    await createOidcAttempt(pool, {
      state,
      codeVerifier,
      returnTo,
      at: now,
      expiresAt: now + 10 * 60_000,
    })
    const configuration = await oidcConfiguration(config)
    const url = buildAuthorizationUrl(configuration, {
      redirect_uri: callbackUrl(config),
      response_type: 'code',
      scope: 'openid profile email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    return c.redirect(url.toString())
  })

  app.get('/api/v1/auth/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (code === undefined || state === undefined) {
      return c.json({ error: 'the callback carries no code or state' }, 400)
    }
    const attempt = await takeOidcAttempt(pool, state)
    if (attempt === undefined)
      return c.json({ error: 'the sign-in attempt is unknown or expired' }, 401)
    try {
      const configuration = await oidcConfiguration(config)
      const currentUrl = new URL(callbackUrl(config))
      currentUrl.searchParams.set('code', code)
      currentUrl.searchParams.set('state', state)
      const tokens = await authorizationCodeGrant(configuration, currentUrl, {
        expectedState: state,
        pkceCodeVerifier: attempt.codeVerifier,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      const subject = claims?.sub
      if (subject === undefined) throw new Error('the identity provider returned no subject')
      const email = typeof claims?.email === 'string' ? claims.email : undefined
      // #218: Keycloak sends `groups` as an array when a user has several and
      // as a single string when it has one. Both shapes are accepted, and the
      // result is deduplicated.
      const principal: Principal = {
        id: subject,
        displayName:
          (typeof claims?.name === 'string' && claims.name) ||
          (typeof claims?.preferred_username === 'string' && claims.preferred_username) ||
          email ||
          subject,
        ...(email === undefined ? {} : { email }),
        groups: groupIds(claims?.groups),
      }
      await upsertPrincipal(pool, principal)
      const now = Date.now()
      // #218: the refresh token is encrypted at rest and only logout decrypts
      // it. An installation without a valid key stores no refresh token, so
      // logout ends the local session and skips the identity provider.
      const refreshToken =
        typeof tokens.refresh_token === 'string'
          ? encryptStoredRefreshToken(config, tokens.refresh_token)
          : undefined
      const session = await createBrowserSession(pool, {
        principalId: principal.id,
        at: now,
        expiresAt: now + config.session.absoluteHours * 3_600_000,
        ...(refreshToken === undefined ? {} : { refreshToken }),
      })
      setCookie(c, config.session.cookieName, session.id, {
        httpOnly: true,
        secure: config.publicUrl.startsWith('https://'),
        sameSite: 'Lax',
        path: '/',
        maxAge: config.session.absoluteHours * 3600,
      })
      return c.redirect(attempt.returnTo)
    } catch (error) {
      return c.json({ error: `the sign-in could not be completed: ${messageOf(error)}` }, 401)
    }
  })

  app.get('/api/v1/admin/users', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!authorize(grants, 'org.grants', 'org')) {
      return c.json({ error: 'the principal may not read the directory' }, 403)
    }
    return c.json(await listDirectoryUsers(config))
  })

  app.all('*', (c) => c.json({ error: 'not found in this slice' }, 404))

  return app
}

/** Start the HTTP server on the configured address and return a drain handle. */
export async function serveHttp(config: Config): Promise<ServedHttp> {
  const pool = createPool(config.databaseUrl)
  const app = createApp(config, pool)
  const { hostname, port } = listenAddress(config)
  const server = serve({ fetch: app.fetch, hostname, port })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await pool.end()
    },
  }
}

/** The issuer discovery URL, exposed for `doctor` (DE-5). */
export function issuerOf(config: Config): string {
  return issuerUrl(config)
}

/**
 * Resolve the request's credential to one principal and one session row
 * (ADR 0012). A bad or expired bearer token, a revoked cookie session and an
 * expired idle timeout all answer undefined, which the route turns into 401.
 */
async function authenticate(c: Context, pool: Pool, config: Config): Promise<Auth | undefined> {
  const authorization = c.req.header('authorization')
  if (authorization?.toLowerCase().startsWith('bearer ') === true) {
    const token = authorization.slice('bearer '.length).trim()
    if (token === '') return undefined
    let principal: Principal
    try {
      principal = await principalFromToken(config, token)
    } catch {
      return undefined
    }
    const now = Date.now()
    const expiresAt = tokenExpiry(token)
    if (expiresAt !== undefined && expiresAt <= now) return undefined
    await upsertPrincipal(pool, principal)
    const session = await upsertBearerSession(pool, {
      principalId: principal.id,
      tokenHash: hashToken(token),
      at: now,
      expiresAt: expiresAt ?? now + 5 * 60_000,
    })
    // A revoked row stays revoked: logout must not be undone by the next
    // request that carries the same token (ID-5).
    if (session.revokedAt !== null) return undefined
    return { kind: 'bearer', principal, session }
  }

  const sessionId = getCookie(c, config.session.cookieName)
  if (sessionId === undefined) return undefined
  const session = await sessionById(pool, sessionId)
  if (session === undefined || session.revokedAt !== null) return undefined
  const now = Date.now()
  if (session.expiresAt <= now) return undefined
  if (session.lastSeenAt + config.session.idleMinutes * 60_000 <= now) return undefined
  const principal = await principalById(pool, session.principalId)
  if (principal === undefined) return undefined
  await touchSession(pool, session.id, now)
  return { kind: 'cookie', principal, session: { ...session, lastSeenAt: now } }
}

/** The callback URL: the configured public URL, never the request's Host. */
function callbackUrl(config: Config): string {
  return `${config.publicUrl}/api/v1/auth/callback`
}

/** Only a relative path may be a return target (ID-2). */
function safeReturnTo(value: string | undefined): string {
  if (value === undefined || value === '') return '/'
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  return value
}

/** The SHA-256 of an access token, so the session stores no token (ADR 0012). */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Encrypt a refresh token for the session row (#218, ADR 0012). An absent or
 * invalid key stores nothing: the local session still works and logout ends
 * only the local session.
 */
function encryptStoredRefreshToken(config: Config, token: string): string | undefined {
  if (!validEncryptionKey(config.session.encryptionKey)) return undefined
  return encryptToken(config.session.encryptionKey, token)
}

/**
 * Decrypt a stored refresh token, or undefined when the key is absent or the
 * value does not decrypt. The caller has already revoked the local session, so
 * a failed decryption skips the identity provider logout (#218).
 */
function decryptStoredRefreshToken(config: Config, stored: string | null | undefined) {
  if (stored === null || stored === undefined) return undefined
  if (!validEncryptionKey(config.session.encryptionKey)) return undefined
  try {
    return decryptToken(config.session.encryptionKey, stored)
  } catch {
    return undefined
  }
}

/** One 401 body, the same shape for every credential (ADR 0012). */
function unauthorized(c: Context) {
  return c.json({ error: 'there is no session; sign in first' }, 401)
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
