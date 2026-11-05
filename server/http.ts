// Issue #216, DE-1, DE-3, ID-4, ID-5, ID-6, ADR 0011, ADR 0012: the HTTP
// server. It answers the liveness, readiness and version surfaces of DE-3, the
// session and sign-in surfaces of ADR 0012 and the flow surfaces of #220. The
// browser authenticates with the server-side session cookie and the CLI with a
// bearer token; both map to one principal and one session row. A path that
// this slice does not serve answers 404, and the PR says which ones.
//
// Issue #220, DF-1, DF-2, DF-4, DF-5, I4, I5, I8, I14: an administrator
// creates, edits and publishes a flow through the engine. The server resolves
// the request, calls the engine, appends the operation and projects it; the
// engine decides authorization, classification and publication (A9).
//
// Issue #238, S13, WF-4, WF-5, AC-5, I5, I8, I14: a starter withdraws their
// own instance, a principal with `instance.cancel` cancels any instance with a
// reason, and the actor who closed it undoes the close within the flow's undo
// period. The server loads the instance, refuses a stale close view, calls the
// engine and appends the operation the engine decided; the session is the
// actor.

import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { type Context, Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client'
import type { Pool } from 'pg'
import { STEP_CLAIMED, STEP_COMPLETED } from '../engine/action.js'
import { authorize, type Grant } from '../engine/authorize.js'
import { type FlowDefinition, type JsonValue, parse } from '../engine/definition.js'
import { definitionDiff, type VersionRef } from '../engine/diff.js'
import { dryRun } from '../engine/dryrun.js'
import { classifyChange, type DefinitionChange } from '../engine/edit.js'
import {
  changeTitle,
  createFlow,
  type Flow,
  publish,
  publishedByHash,
  publishedFlow,
  publishedVersion,
  push,
  STARTER_DEFINITION,
} from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { instanceOf, readInstance, readInstanceStep } from '../engine/instances.js'
import { readableLog } from '../engine/logRead.js'
import { definitionByHash, mergeDefinitions } from '../engine/merge.js'
import {
  createOperation,
  type Log,
  type Operation,
  type OperationDeps,
} from '../engine/operation.js'
import { renderInstancePdf } from '../engine/pdf.js'
import type { TargetResolver } from '../engine/routing.js'
import { STEP_SENT_BACK } from '../engine/sendBack.js'
import { mayRead } from '../engine/status.js'
import { INSTANCE_STARTED, INSTANCE_SUBMITTED } from '../engine/submission.js'
import { teamsOf } from '../engine/teams.js'
import { flowOf, isConfigChange, timeline, timelineFor } from '../engine/timeline.js'
import { rebindDraft } from '../engine/version.js'
import { type Config, issuerUrl, listenAddress } from './config.js'
import { decryptToken, encryptToken, validEncryptionKey } from './crypto.js'
import {
  appendOperation,
  clearedSeedIds,
  createBrowserSession,
  createOidcAttempt,
  createPool,
  flowExists,
  grantsOfFlow,
  grantsOfPrincipal,
  groupMembersFromPrincipals,
  type InboxTab,
  isClearedSeedRecord,
  listFlowSummaries,
  type Principal,
  principalById,
  readEventByOperation,
  readFlowProjection,
  readInboxRows,
  readLog,
  readTeamMembers,
  readUnroutableRows,
  revokeSession,
  type SessionRow,
  sessionById,
  takeOidcAttempt,
  touchSession,
  upsertBearerSession,
  upsertPrincipal,
} from './db.js'
import { newOperationId } from './ids.js'
import { grantsFor, resolveClientOperation, resolverFor } from './intents.js'
import {
  createDirectoryUser,
  DirectoryUserExistsError,
  directoryGroupMembers,
  directoryUser,
  disableDirectoryUser,
  endIdpSession,
  groupIds,
  listDirectoryGroups,
  listDirectoryUsers,
  oidcConfiguration,
  principalFromToken,
  tokenExpiry,
} from './keycloak.js'
import { attachRealtime, createHub, followLog, type Hub, type Scope } from './realtime.js'
import { mountInterface } from './static.js'
import { DeprovisionRefused, deprovisionPrincipal, directoryFor } from './sync.js'
import { versionLine } from './version.js'

/** The injected sources of a server-created operation (I6, ADR 0004). */
const operationDeps: OperationDeps = { clock: () => Date.now(), ids: () => newOperationId() }

/**
 * The undo period of a flow that does not set one (WF-5, S13, S16): 24 hours,
 * the server default that `undoHours` overrides.
 */
const DEFAULT_UNDO_HOURS = 24

/** One hour in milliseconds, the unit that the engine's undo period takes. */
const HOUR_MS = 3_600_000

/**
 * The scopes that let a principal read a flow (#220). `flow.read` reads the
 * published definition, `flow.edit` and `flow.build` read the draft, and
 * `instance.start` reads the published definition to start an instance. The
 * engine's `*` resource covers every flow, so an administrator's wildcard
 * grant lists and reads them all.
 */
const FLOW_READ_SCOPES = ['flow.read', 'flow.edit', 'flow.build', 'instance.start'] as const

/**
 * The intents whose resolution routes a step and so reads the directory
 * (AS-1, AS-4): a submit, a completion and a send back resolve the entered
 * step's targets; a start resolves the starter only.
 */
const ROUTING_INTENTS: ReadonlySet<string> = new Set([
  INSTANCE_SUBMITTED,
  STEP_COMPLETED,
  STEP_SENT_BACK,
  STEP_CLAIMED,
])

/** The running HTTP server and the way to drain it (DE-3). */
/** The public client of the realm that the CLI signs in with (#258, DX-3): deploy/keycloak/realms. */
const CLI_CLIENT_ID = 'enform-cli'

export type ServedHttp = {
  readonly port: number
  readonly close: () => Promise<void>
}

/** One authenticated request: the principal and the session row behind it. */
type Auth =
  | { readonly kind: 'bearer'; readonly principal: Principal; readonly session: SessionRow }
  | { readonly kind: 'cookie'; readonly principal: Principal; readonly session: SessionRow }

/** Build the HTTP application for one configuration and one pool. */
export function createApp(config: Config, pool: Pool, hub: Hub = createHub()): Hono {
  const app = new Hono()

  // Issue #260, RT-1, RT-2, I8: the realtime hub reads who a connection is
  // and what it may read through the same authentication and reads as the
  // routes, so no subscription bypasses `mayRead`.
  hub.configure({
    authenticate: async (headers) => {
      const auth = await authenticateHeaders(headers, pool, config)
      return auth === undefined ? undefined : auth.principal
    },
    authorize: async (principal, scope) => {
      const log = await readLog(pool)
      const grants = grantsFor(log, principal)
      if ('flow' in scope) return mayReadFlow(grants, scope.flow) ? 'ok' : 'refused'
      const instance = instanceOf(log, scope.instance)
      if (instance === undefined) return 'missing'
      const published = publishedByHash(log, instance.definitionVersion)
      if (published === undefined) return 'missing'
      const readable = mayRead(principal.id, instance, {
        flow: instance.flow,
        definition: published.definition,
        log,
        grants,
      })
      return readable ? 'ok' : 'refused'
    },
    head: async () => (await readLog(pool)).length,
  })

  // The Server-Sent Events fallback (RT-1, ADR 0006): one scope per stream,
  // authorized when the stream opens (I8); `welcome`, then every change and
  // presence of the scope, as the WebSocket channel sends them.
  app.get('/api/v1/realtime/events', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const instance = nonEmpty(c.req.query('instance'))
    const flow = nonEmpty(c.req.query('flow'))
    const scope: Scope | undefined =
      instance !== undefined && flow === undefined
        ? { instance }
        : flow !== undefined && instance === undefined
          ? { flow }
          : undefined
    if (scope === undefined) {
      return c.json({ error: 'the stream names one instance or one flow' }, 400)
    }
    const decision = await hub.deps().authorize(auth.principal, scope)
    if (decision === 'missing') return c.json({ error: 'not found' }, 404)
    if (decision === 'refused') return c.json({ error: 'not readable' }, 403)
    const head = await hub.deps().head()
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'welcome',
        data: JSON.stringify({
          type: 'welcome',
          protocol: 1,
          principal: auth.principal,
          seq: head,
        }),
      })
      const off = hub.subscribe(scope, (message) => {
        void stream.writeSSE({ event: message.type, data: JSON.stringify(message) })
      })
      const keepAlive = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '{"type":"ping"}' })
      }, 25_000)
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(keepAlive)
          off()
          resolve()
        })
      })
    })
  })

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

  // Issue #224: the app and the API share one origin. The interface is
  // registered before the API routes, so `/app/*` and `/client/*` never cover
  // `/api/v1`, `/healthz`, `/readyz` or `/version`.
  mountInterface(app)

  app.get('/api/v1/session', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    return c.json({
      principal: auth.principal,
      // The grants that apply to the principal (AC-1, DF-5, #264), so the
      // builder knows which controls the server would refuse (I8).
      grants: await grantsOfPrincipal(pool, auth.principal.id),
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

  // Issue #258, DX-3, S01: the CLI signs in through the identity provider's
  // device authorization flow. The answer is public, because a sign-in has
  // no credential yet, and it names no secret: the CLI client is a public
  // client of the realm.
  app.get('/api/v1/auth/cli', (c) => {
    const issuer = issuerUrl(config)
    return c.json({
      clientId: CLI_CLIENT_ID,
      deviceAuthorizationEndpoint: `${issuer}/protocol/openid-connect/auth/device`,
      tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
    })
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
      // #224: the authorization response carries parameters beyond code and
      // state (iss, session_state). The code grant validates them, so the
      // callback URL keeps every parameter the request arrived with.
      const currentUrl = new URL(callbackUrl(config))
      for (const [name, value] of new URL(c.req.url).searchParams) {
        currentUrl.searchParams.set(name, value)
      }
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

  // Issue #252, ID-6, AS-1, I8: the directory groups and their members. The
  // read is the administrator surface, so it requires `org.grants` on the
  // organization exactly as the user list does. A group target names the id
  // that this read lists (I10).
  // Issue #267, ID-5, ID-6, I8, I14, WF-5: an administrator deprovisions one
  // directory user. The account is disabled in the identity provider first,
  // so it signs in no more; then the engine releases every task the person
  // holds with the reason and records the account, in one transaction. The
  // scope is checked before the directory is touched (I8).
  app.post('/api/v1/admin/users/:id/deprovision', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!authorize(grants, 'org.grants', 'org')) {
      return c.json({ error: 'the principal may not deprovision a directory user' }, 403)
    }
    const id = c.req.param('id')
    const user = await directoryUser(config, id)
    if (user === undefined && (await principalById(pool, id)) === undefined) {
      return c.json({ error: `neither the directory nor the log knows ${id}` }, 404)
    }
    if (user !== undefined) await disableDirectoryUser(config, id)
    try {
      return c.json(
        await deprovisionPrincipal(pool, id, Date.now(), { actor: auth.principal.id, grants })
      )
    } catch (error) {
      if (error instanceof DeprovisionRefused) return c.json({ error: error.message }, 403)
      throw error
    }
  })

  app.get('/api/v1/admin/groups', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!authorize(grants, 'org.grants', 'org')) {
      return c.json({ error: 'the principal may not read the directory' }, 403)
    }
    return c.json(await listDirectoryGroups(config))
  })

  // The teams and their members (AS-6, AS-4, #256): a projection of the log
  // that any signed-in principal may read, because a target names a team by
  // its name and the builder offers them. The write path is a
  // `config.team.changed@1` intent on `POST /api/v1/operations`.
  app.get('/api/v1/teams', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const log = await readLog(pool)
    return c.json(teamsOf(log).map((team) => ({ name: team.name, members: [...team.members] })))
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

  // Issue #228, ID-6, DE-1, ADR 0012: an administrator creates a local user
  // with a generated temporary password. Keycloak owns the credential; enform
  // returns the password once and stores and logs it never. An invite needs a
  // mail transport that this slice does not configure (SE-1, SE-2), so it
  // answers 409 and creates nothing.
  app.post('/api/v1/admin/users', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const body = await readJsonObject(c)
    const input = body === undefined ? undefined : readCreateUser(body)
    if (input === undefined) {
      return c.json(
        { error: 'the body needs an email, a display name and sendInvite', code: 'invalid-user' },
        400
      )
    }
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!authorize(grants, 'org.grants', 'org')) {
      return c.json({ error: 'the principal may not create a directory user' }, 403)
    }
    if (input.sendInvite) {
      return c.json(
        { error: 'the mail transport is not configured', code: 'mail-not-configured' },
        409
      )
    }
    try {
      const created = await createDirectoryUser(config, {
        email: input.email,
        displayName: input.displayName,
        ...(input.managerId === undefined ? {} : { managerId: input.managerId }),
      })
      return c.json(
        {
          id: created.id,
          displayName: input.displayName,
          email: input.email,
          status: 'active',
          groups: [],
          temporaryPassword: created.temporaryPassword,
          ...(input.managerId === undefined ? {} : { managerId: input.managerId }),
        },
        201
      )
    } catch (error) {
      if (error instanceof DirectoryUserExistsError) {
        return c.json(
          { error: `the directory already holds ${input.email}`, code: 'email-exists' },
          409
        )
      }
      throw error
    }
  })

  app.get('/api/v1/flows', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const summaries = await listFlowSummaries(pool)
    // A cleared seed flow is absent from the projection already; the seed
    // record check keeps the list honest even if a read races a clear (DE-4).
    const cleared = await clearedSeedIds(pool, 'flow')
    return c.json(
      summaries
        .filter((summary) => !cleared.has(summary.slug))
        .filter((summary) => mayReadFlow(grants, summary.slug))
    )
  })

  app.post('/api/v1/flows', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const body = await readJsonObject(c)
    const input = body === undefined ? undefined : readCreateFlow(body)
    if (input === undefined) {
      return c.json({ error: 'the body needs a slug and an optional title' }, 400)
    }
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const resource = `flow:${input.slug}`
    if (!authorize(grants, 'flow.build', resource)) {
      return c.json({ error: `creating a flow requires the scope flow.build on ${resource}` }, 403)
    }
    if (await flowExists(pool, input.slug)) {
      return c.json(
        { error: `a flow with the slug ${input.slug} already exists`, code: 'slug-exists' },
        409
      )
    }
    const pushed = push(
      createFlow(input.slug),
      STARTER_DEFINITION,
      operationDeps,
      auth.principal.id,
      grants
    )
    await appendOperation(pool, pushed.operation)
    if (input.title !== undefined) {
      await appendOperation(
        pool,
        changeTitle(input.slug, input.title, operationDeps, auth.principal.id)
      )
    }
    return c.json(
      { slug: input.slug, version: 1, definition: pushed.flow.draft ?? STARTER_DEFINITION },
      201
    )
  })

  app.get('/api/v1/flows/:slug/draft', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const slug = c.req.param('slug')
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!mayReadDraft(grants, slug)) {
      return c.json({ error: `reading the draft requires a flow scope on flow:${slug}` }, 403)
    }
    const stored = await readFlowProjection(pool, slug)
    if (stored === undefined || stored.flow.draft === undefined) {
      return c.json({ error: `no flow with the slug ${slug} has a draft` }, 404)
    }
    // The read names the hash of the draft, so a write can name the copy it
    // is based on and merge with a write made beside it (DF-3, S03, #264).
    return c.json({
      slug,
      version: stored.draftVersion,
      draftHash: contentHash(stored.flow.draft),
      definition: stored.flow.draft,
    })
  })

  app.put('/api/v1/flows/:slug/draft', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const body = await readJsonObject(c)
    const input = body === undefined ? undefined : readDraftWrite(body)
    if (input === undefined) {
      return c.json({ error: 'the body needs a version and a definition' }, 400)
    }
    let definition: FlowDefinition
    try {
      definition = parse(JSON.stringify(input.definition))
    } catch (error) {
      return c.json(
        { error: `the definition is not valid: ${messageOf(error)}`, code: 'invalid-definition' },
        422
      )
    }
    const slug = c.req.param('slug')
    const stored = await readFlowProjection(pool, slug)
    if (stored === undefined) {
      return c.json({ error: `there is no flow with the slug ${slug}` }, 404)
    }
    if (input.version !== stored.draftVersion) {
      return c.json(
        {
          error: `the draft version is ${stored.draftVersion}; ${input.version} is stale`,
          code: 'version-stale',
        },
        409
      )
    }
    // Two people edit the draft at the same time and nobody is blocked (DF-3,
    // S03, #264): a write that names the draft it was based on merges with
    // the draft another write left since. The engine merges three ways; a
    // place both changed differently is a conflict the writer decides (A1).
    const current = stored.flow.draft
    if (
      input.baseHash !== undefined &&
      current !== undefined &&
      input.baseHash !== contentHash(current)
    ) {
      const base = definitionByHash(await readLog(pool), slug, input.baseHash)
      if (base === undefined) {
        return c.json(
          {
            error: `the draft moved on since the copy ${input.baseHash} was read`,
            code: 'version-stale',
          },
          409
        )
      }
      const merged = mergeDefinitions(base, definition, current)
      if (merged.definition === undefined) {
        const paths = merged.conflicts.map((conflict) => conflict.path).join(', ')
        return c.json(
          {
            error: `the draft changed at the same places since it was read: ${paths}`,
            code: 'version-stale',
            conflicts: merged.conflicts,
          },
          409
        )
      }
      try {
        definition = parse(JSON.stringify(merged.definition))
      } catch (error) {
        return c.json(
          {
            error: `the merged draft is not valid: ${messageOf(error)}`,
            code: 'version-stale',
          },
          409
        )
      }
    }
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const changes = changesForPush(stored.flow, definition)
    if (!changeAllowed(grants, slug, changes)) {
      return c.json({ error: refusalFor(slug, changes) }, 403)
    }
    const pushed = push(stored.flow, definition, operationDeps, auth.principal.id, grants)
    await appendOperation(pool, pushed.operation)
    // The write answers the field-level changes it made, with their paths, so
    // the builder shows what changed (DF-3, DF-6, #256), and the hash of the
    // draft it left, so the next write names its base (S03).
    const draft = pushed.flow.draft ?? definition
    return c.json({
      slug,
      version: stored.draftVersion,
      draftHash: contentHash(draft),
      definition: draft,
      changes,
    })
  })

  // Issue #264, DR-1, DR-3, DR-4, DR-5, DR-6, I7, I8: a dry run of a version
  // or the draft. The engine routes, resolves and previews; the route reads
  // the definition, the directory and the grants, writes nothing of the run,
  // and records only an impersonated run (DR-5, I14).
  app.post('/api/v1/flows/:slug/dry-run', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const slug = c.req.param('slug')
    const body = await readJsonObject(c)
    if (body === undefined || !isRecord(body.data)) {
      return c.json({ error: 'the body needs the data of the request form' }, 400)
    }
    const requested = body.version ?? 'draft'
    const versionValue: number | 'draft' =
      requested === 'draft'
        ? 'draft'
        : typeof requested === 'number'
          ? requested
          : typeof requested === 'string' && /^[1-9][0-9]*$/.test(requested)
            ? Number(requested)
            : Number.NaN
    if (versionValue !== 'draft' && (!Number.isInteger(versionValue) || versionValue < 1)) {
      return c.json({ error: 'version is a published version number or draft' }, 400)
    }
    const advance = body.advanceMinutes ?? 0
    if (typeof advance !== 'number' || !Number.isInteger(advance) || advance < 0) {
      return c.json({ error: 'advanceMinutes must be a non-negative integer' }, 400)
    }
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const resource = `flow:${slug}`
    if (
      !['flow.dryrun', 'flow.edit', 'flow.build'].some((scope) =>
        authorize(grants, scope, resource)
      )
    ) {
      return c.json(
        { error: `a dry run requires flow.dryrun, flow.edit or flow.build on ${resource}` },
        403
      )
    }
    const as = nonEmpty(typeof body.as === 'string' ? body.as : undefined)
    if (
      as !== undefined &&
      as !== auth.principal.id &&
      !authorize(grants, 'org.impersonate', 'org')
    ) {
      return c.json(
        { error: 'running as another person requires org.impersonate on org (DR-5)' },
        403
      )
    }
    let definition: FlowDefinition
    if (versionValue === 'draft') {
      const stored = await readFlowProjection(pool, slug)
      if (stored === undefined || stored.flow.draft === undefined) {
        return c.json({ error: `no flow with the slug ${slug} has a draft` }, 404)
      }
      definition = stored.flow.draft
    } else {
      const published = publishedVersion(await readLog(pool), slug, versionValue)
      if (published === undefined) {
        return c.json({ error: `the flow ${slug} has no published version ${versionValue}` }, 404)
      }
      definition = published.definition
    }
    const actor = as ?? auth.principal.id
    const data = body.data as Record<string, JsonValue>
    const log = await readLog(pool)
    const teamMembers = await teamMembersFor(pool, log)
    // A dry run resolves the live targets through the directory, like a live
    // run (AS-4); when the identity provider cannot be reached it answers
    // from the membership the profile cache recorded at the last sign-in or
    // sync (ID-5), with nobody deprovisioned and no manager known, so a
    // rehearsal never depends on the directory being up.
    const groupMembers = await groupMembersFor(config).catch(() => groupMembersFromPrincipals(pool))
    const directory = await directoryFor(config, log, [actor]).catch(() => ({}))
    const now = Date.now()
    const result = dryRun({
      definition,
      data,
      actor,
      resolve: resolverFor(actor, data, teamMembers, groupMembers, directory),
      now,
      advanceMs: advance * 60_000,
    })
    if (as !== undefined && as !== auth.principal.id) {
      // The log records each impersonated run (DR-5, I14); nothing else of
      // the run is stored (DR-6).
      await appendOperation(
        pool,
        createOperation(
          'dryrun.ran@1',
          { flow: slug, version: String(versionValue), as },
          operationDeps,
          auth.principal.id
        )
      )
    }
    return c.json({ flow: slug, version: String(versionValue), actor, now, ...result })
  })

  app.post('/api/v1/flows/:slug/publish', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const body = await readJsonObject(c)
    const input = body === undefined ? undefined : readPublish(body)
    if (input === undefined) {
      return c.json({ error: 'the body needs a version' }, 400)
    }
    const slug = c.req.param('slug')
    const stored = await readFlowProjection(pool, slug)
    if (stored === undefined || stored.flow.draft === undefined) {
      return c.json({ error: `no flow with the slug ${slug} has a draft` }, 404)
    }
    if (input.version !== stored.draftVersion) {
      return c.json(
        {
          error: `the draft version is ${stored.draftVersion}; ${input.version} is stale`,
          code: 'version-stale',
        },
        409
      )
    }
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const changes = changesForPublish(stored.flow)
    if (!changeAllowed(grants, slug, changes)) {
      return c.json({ error: refusalFor(slug, changes) }, 403)
    }
    const published = publish(stored.flow, operationDeps, auth.principal.id, grants)
    await appendOperation(pool, published.operation)
    const version = published.flow.versions[published.flow.versions.length - 1]
    return c.json({
      slug,
      version: version.version,
      contentHash: version.contentHash,
      definition: version.definition,
    })
  })

  app.get('/api/v1/flows/:slug', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const slug = c.req.param('slug')
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!mayReadFlow(grants, slug)) {
      return c.json({ error: `reading the flow requires a scope on flow:${slug}` }, 403)
    }
    // The newest publication, or the version the query names (DF-6, S15,
    // #258), so a diff between two published versions reads both.
    const requested = nonEmpty(c.req.query('version'))
    const number = requested === undefined ? undefined : Number(requested)
    if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
      return c.json({ error: 'version must be a positive integer' }, 400)
    }
    const log = await readLog(pool)
    const published =
      number === undefined ? publishedFlow(log, slug) : publishedVersion(log, slug, number)
    if (published === undefined || (await readFlowProjection(pool, slug)) === undefined) {
      return c.json(
        {
          error:
            number === undefined
              ? `no published flow has the slug ${slug}`
              : `the flow ${slug} has no published version ${number}`,
        },
        404
      )
    }
    return c.json({
      slug,
      version: published.version,
      contentHash: published.contentHash,
      definition: published.definition,
    })
  })

  // Issue #264, DF-6, S03, S04, I8, I14: the attributed difference between
  // two points of a flow's history. The engine reads it from the log; the
  // route only parses the points and authorizes the read: a version needs a
  // flow read scope, the draft a draft scope.
  app.get('/api/v1/flows/:slug/diff', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const slug = c.req.param('slug')
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!mayReadFlow(grants, slug)) {
      return c.json({ error: `reading the flow requires a scope on flow:${slug}` }, 403)
    }
    const from = versionRefOf(c.req.query('from'))
    const toRef = versionRefOf(c.req.query('to'))
    if (from === null || toRef === null) {
      return c.json({ error: 'a point is a positive version number or draft' }, 400)
    }
    const to = toRef === undefined ? 'draft' : toRef
    if ((from === 'draft' || to === 'draft') && !mayReadDraft(grants, slug)) {
      return c.json({ error: `reading the draft requires a flow scope on flow:${slug}` }, 403)
    }
    const diff = definitionDiff(await readLog(pool), slug, from, to)
    if (diff === undefined) {
      return c.json({ error: `the flow ${slug} has no such version` }, 404)
    }
    return c.json({
      slug,
      from: String(diff.from),
      to: String(diff.to),
      changes: diff.changes,
    })
  })

  // Issue #232, AC-1, AC-2, I8: the grants on one flow and its steps. This is
  // the administrator's view that the builder reads to show and add starters,
  // so a principal without `flow.grant` on the flow or `org.grants` on the
  // organization reads nothing. The grants are a projection of the log (I4)
  // and answer in log order.
  app.get('/api/v1/flows/:slug/grants', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const slug = c.req.param('slug')
    const resource = `flow:${slug}`
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!authorize(grants, 'org.grants', 'org') && !authorize(grants, 'flow.grant', resource)) {
      return c.json(
        {
          error: `reading the grants requires the scope org.grants on org or flow.grant on ${resource}`,
        },
        403
      )
    }
    return c.json(await grantsOfFlow(pool, slug))
  })

  app.post('/api/v1/operations', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    if (!csrfOk(c, auth)) return csrfRefused(c)
    const body = await readJsonObject(c)
    if (body === undefined || typeof body.type !== 'string') {
      return c.json({ error: 'the body needs an operation' }, 400)
    }
    return serveOperation(c, pool, config, auth, body)
  })

  // The log read is authorized (I8, #256): the engine keeps the events of the
  // instances the principal may read, the configuration changes of the flows
  // it holds instance.timeline on, and everything for org.grants. The
  // `instance` and `limit` queries serve `enform log` (S16, DX-3).
  app.get('/api/v1/log', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const log = await readLog(pool)
    const instanceId = nonEmpty(c.req.query('instance'))
    const limitQuery = nonEmpty(c.req.query('limit'))
    const limit = limitQuery === undefined ? undefined : Number(limitQuery)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      return c.json({ error: 'limit must be a non-negative integer' }, 400)
    }
    // The polling fallback reads the events after a position (#260, RT-1).
    const afterQuery = nonEmpty(c.req.query('after'))
    const after = afterQuery === undefined ? undefined : Number(afterQuery)
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
      return c.json({ error: 'after must be a non-negative integer' }, 400)
    }
    const teamMembers = await teamMembersFor(pool, log)
    const groupMembers = await groupMembersFor(config)
    const resolve = resolverFor(undefined, {}, teamMembers, groupMembers)
    // The read is authorized over the whole log (I8): an instance's events
    // are readable through the instance the log holds, so the position
    // filter applies to the answer, not to what the authorization reads.
    const flow = nonEmpty(c.req.query('flow'))
    const readable = readableLog(log, auth.principal.id, {
      grants: grantsFor(log, auth.principal),
      resolve,
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(flow === undefined ? {} : { flow }),
    })
    const since = after === undefined ? readable : readable.filter((event) => event.seq > after)
    return c.json(
      limit === undefined || limit >= since.length ? since : since.slice(since.length - limit)
    )
  })

  // The whole derived state is the organization's (I8): org.grants on org.
  app.get('/api/v1/state', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const log = await readLog(pool)
    if (!authorize(grantsFor(log, auth.principal), 'org.grants', 'org')) {
      return c.json({ error: 'the state needs org.grants on org' }, 403)
    }
    return c.json({ applied: log.map((event) => event.operationId), log })
  })

  app.get('/api/v1/instances/:instanceId', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const instanceId = c.req.param('instanceId')
    // The log still holds a cleared demo instance (I4). The seed record is the
    // operational mark that its projection was removed, so the read answers
    // 404 exactly as a missing projection row would (DE-4).
    if (await isClearedSeedRecord(pool, 'instance', instanceId)) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    let log = await readLog(pool)
    let instance = instanceOf(log, instanceId)
    if (instance === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    // An open draft moves to the newest published version when its starter
    // opens it again (RT-6, S04): the rebind is an attributed operation that
    // keeps every value and names what no longer fits, appended before the
    // read answers, so the form the author sees is the version they submit.
    if (instance.submitted === false && instance.starter === auth.principal.id) {
      const newest = publishedFlow(log, instance.flow)
      if (newest !== undefined && newest.contentHash !== instance.definitionVersion) {
        const rebound = rebindDraft(instance, auth.principal.id, newest, operationDeps)
        if (rebound.accepted && rebound.operation !== undefined) {
          await appendOperation(pool, rebound.operation)
          log = await readLog(pool)
          instance = instanceOf(log, instanceId) ?? instance
        }
      }
    }
    const published = publishedByHash(log, instance.definitionVersion)
    if (published === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    // The session identifies the actor. The optional `actor` query parameter is
    // the harness compatibility seam and is ignored here (#222).
    const view = readInstance(
      auth.principal.id,
      instance,
      {
        flow: instance.flow,
        definition: published.definition,
        log,
        grants: grantsFor(log, auth.principal),
      },
      await resolverForRequest(config, pool, log, instance.starter, instance.values ?? {})
    )
    if (view === undefined) {
      return c.json({ error: 'the principal may not read the instance' }, 403)
    }
    // The undo window is the close time plus the flow's period; an absent
    // setting uses the server default (WF-5, S13). The engine read carries the
    // close marker and the closer, and the server adds the window so the page
    // knows when the Undo control stops being offered.
    const undoHours = published.definition.undoHours ?? DEFAULT_UNDO_HOURS
    return c.json(
      view.closedAt === undefined
        ? view
        : { ...view, undoUntil: view.closedAt + undoHours * HOUR_MS }
    )
  })

  // Issue OU-1, FM-3, VT-2, VT-5, I4, I8, I12, I13, ADR 0009: the instance
  // PDF. It is another read of the instance through the same engine rule as
  // the instance read, so a principal without `mayRead` answers 403 and a
  // cleared or unknown instance answers 404. The form is the current step by
  // default or the `step` query, with the step's rules and the values the
  // actor may read; the history is the instance's tracker and timeline (I4).
  app.get('/api/v1/instances/:instanceId/pdf', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const instanceId = c.req.param('instanceId')
    if (await isClearedSeedRecord(pool, 'instance', instanceId)) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    const log = await readLog(pool)
    const instance = instanceOf(log, instanceId)
    if (instance === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    const published = publishedByHash(log, instance.definitionVersion)
    if (published === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    const requested = nonEmpty(c.req.query('step'))
    if (
      requested !== undefined &&
      !published.definition.steps.some((step) => step.key === requested)
    ) {
      return c.json({ error: `no step has the key ${requested}` }, 404)
    }
    const context = {
      flow: instance.flow,
      definition: published.definition,
      log,
      grants: grantsFor(log, auth.principal),
    }
    const resolver = await resolverForRequest(
      config,
      pool,
      log,
      instance.starter,
      instance.values ?? {}
    )
    const view =
      requested === undefined
        ? readInstance(auth.principal.id, instance, context, resolver)
        : readInstanceStep(auth.principal.id, instance, context, requested, resolver)
    if (view === undefined) {
      return c.json({ error: 'the principal may not read the instance' }, 403)
    }
    const stored = await readFlowProjection(pool, instance.flow)
    const step = requested ?? view.status.currentStep ?? view.status.state
    const pdf = renderInstancePdf({
      flowSlug: instance.flow,
      ...(stored?.title === undefined ? {} : { flowTitle: stored.title }),
      instanceId,
      actor: auth.principal.id,
      step,
      now: operationDeps.clock(),
      view,
      timeline: timeline(log.filter((event) => event.payload.instanceId === instanceId)),
    })
    return c.body(new Uint8Array(pdf), 200, {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${pdfFilename(instance.flow, instanceId, step)}"`,
    })
  })

  // Issue #246, S15, VT-5, VT-6, I4, I8, I12: the instance timeline and the
  // global change feed. Both are projections of the one log (I4), never a
  // second store. The server filters and authorizes; the engine maps the
  // entries. The instance timeline authorizes the instance's own events with
  // the same rule as the instance read, and adds the flow's configuration
  // changes only to an actor that holds `instance.timeline` on the flow. The
  // global feed requires that scope on the named flow or `org.grants` on the
  // organization, so a requester without it reads nothing (I8).
  app.get('/api/v1/instances/:instanceId/timeline', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const instanceId = c.req.param('instanceId')
    // A cleared demo instance is absent from the live surface (DE-4), exactly
    // as the instance read answers 404 for it.
    if (await isClearedSeedRecord(pool, 'instance', instanceId)) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    const log = await readLog(pool)
    const instance = instanceOf(log, instanceId)
    if (instance === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    const published = publishedByHash(log, instance.definitionVersion)
    if (published === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
    }
    const grants = grantsFor(log, auth.principal)
    if (
      !mayRead(auth.principal.id, instance, {
        flow: instance.flow,
        definition: published.definition,
        log,
        grants,
      })
    ) {
      return c.json({ error: 'the principal may not read the instance' }, 403)
    }
    const includeChanges = includesChanges(c.req.query('includeChanges'))
    if (includeChanges && !authorize(grants, 'instance.timeline', `flow:${instance.flow}`)) {
      return c.json(
        {
          error: `reading the flow's configuration changes requires the scope instance.timeline on flow:${instance.flow}`,
        },
        403
      )
    }
    const events = log.filter(
      (event) =>
        event.payload.instanceId === instanceId ||
        (includeChanges && isConfigChange(event.type) && flowOf(event) === instance.flow)
    )
    return c.json(timeline(events))
  })

  // Issue #246, VT-6, S15, I4, I8: the global change feed. It answers the log
  // in the one global order, filtered by flow and by event type. An actor
  // without `instance.timeline` on the flow and without `org.grants` on the
  // organization reads nothing, so a normal requester answers 403.
  app.get('/api/v1/timeline', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const flow = nonEmpty(c.req.query('flow'))
    const type = nonEmpty(c.req.query('type'))
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const allowed = authorize(grants, 'org.grants', 'org')
    if (!allowed && flow === undefined) {
      return c.json(
        { error: 'the change feed requires instance.timeline on a flow or org.grants on org' },
        403
      )
    }
    if (!allowed && flow !== undefined && !authorize(grants, 'instance.timeline', `flow:${flow}`)) {
      return c.json(
        {
          error: `the change feed requires instance.timeline on flow:${flow} or org.grants on org`,
        },
        403
      )
    }
    const log = await readLog(pool)
    return c.json(
      timelineFor(log, {
        ...(flow === undefined ? {} : { flow }),
        ...(type === undefined ? {} : { type }),
      })
    )
  })

  // Issue #226, VT-1, VT-2, S14, AS-2, AC-5, I8: the inbox. The three tabs
  // read the instance and task projections, and the engine authorizes every
  // row before it leaves the server, so the inbox never shows another
  // principal's task. The state comes from the task projection; the instance
  // status answers for a current step that has no task row yet.
  app.get('/api/v1/inbox', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const tab = readInboxTab(c.req.query('tab'))
    if (tab === undefined) {
      return c.json({ error: 'the inbox tab is my, available or started' }, 400)
    }
    const log = await readLog(pool)
    const grants = grantsFor(log, auth.principal)
    const items: InboxItem[] = []
    const cleared = await clearedSeedIds(pool, 'instance')
    for (const row of await readInboxRows(pool, tab, auth.principal.id)) {
      if (cleared.has(row.instanceId)) continue
      const instance = instanceOf(log, row.instanceId)
      if (instance === undefined) continue
      const published = publishedByHash(log, instance.definitionVersion)
      if (published === undefined) continue
      if (
        !mayRead(auth.principal.id, instance, {
          flow: instance.flow,
          definition: published.definition,
          log,
          grants,
        })
      ) {
        continue
      }
      items.push({
        instanceId: row.instanceId,
        flowSlug: row.flowSlug,
        step: row.step,
        state: inboxState(row.taskState, row.instanceStatus),
        ...(row.holder === null ? {} : { holder: row.holder }),
        ...(row.dueAt === null ? {} : { dueAt: row.dueAt }),
        lastActivityAt: row.lastActivityAt,
      })
    }
    return c.json(items)
  })

  // Issue #252, S08, I10, AS-5, I8: the Unroutable queue. A task whose targets
  // resolve to nobody is in the queue, and the flow owner sees it here. The
  // server authorizes every row against `task.reassign` on the flow (or
  // `org.grants` on the organization), so no other principal reads it.
  app.get('/api/v1/unroutable', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const log = await readLog(pool)
    const grants = grantsFor(log, auth.principal)
    const allowed = authorize(grants, 'org.grants', 'org')
    const items = []
    for (const row of await readUnroutableRows(pool)) {
      if (!allowed && !authorize(grants, 'task.reassign', `flow:${row.flowSlug}`)) continue
      items.push({
        instanceId: row.instanceId,
        flowSlug: row.flowSlug,
        step: row.step,
        state: 'unroutable',
        lastActivityAt: row.lastActivityAt,
      })
    }
    return c.json(items)
  })

  app.all('*', (c) => c.json({ error: 'not found in this slice' }, 404))

  return app
}

/**
 * Append one resolved operation or answer the engine's refusal (#222). A start
 * or a completion is resolved before it is appended; a claim carries the
 * version it read and the engine checks it (I5). A withdraw, a cancel and an
 * undo are close intents that the engine resolves (S13, WF-4, WF-5).
 */
async function serveOperation(
  c: Context,
  pool: Pool,
  config: Config,
  auth: Auth,
  body: Record<string, unknown>
) {
  // A retry of an applied intent is the same change (I1, #256): the server
  // answers the event the log holds and resolves nothing again, so a client
  // whose first answer was lost never reads a refusal for a change that
  // landed.
  if (typeof body.id === 'string') {
    const applied = await readEventByOperation(pool, body.id)
    if (applied !== undefined) return c.json(applied, 201)
  }
  const log = await readLog(pool)
  // The directory is read once per request (AS-4, #252), and only for an
  // intent that routes a step or claims one (#267): the team projection and
  // the Keycloak groups, so every resolution in this request reads one
  // snapshot. A grant never touches the directory. The resolver itself is
  // pure (server/intents.ts).
  const routes = ROUTING_INTENTS.has(String(body.type))
  const claims = body.type === STEP_CLAIMED
  const teamMembers = routes ? await teamMembersFor(pool, log) : new Map()
  // A claim refreshes only the groups the task names (AS-4, #267), never the
  // whole realm; a routing intent may reach any group of the definition.
  const groupMembers = claims
    ? await directoryGroupMembers(config, claimedGroups(log, body))
    : routes
      ? await groupMembersFor(config)
      : new Map()
  // The deprovisioned accounts come from the log and the manager of the
  // starter from the directory (ID-5, AS-1, #267); a claim resolves no
  // dynamic target, so it reads no manager.
  const directory = routes
    ? await directoryFor(config, log, routingStarters(log, body, auth.principal.id))
    : {}
  const resolved = resolveClientOperation(
    {
      log,
      principal: auth.principal,
      grants: grantsFor(log, auth.principal),
      resolver: (starter, data) => resolverFor(starter, data, teamMembers, groupMembers, directory),
      now: () => Date.now(),
    },
    body
  )
  if ('error' in resolved) {
    return c.json(
      { error: resolved.error, ...('errors' in resolved ? { errors: resolved.errors } : {}) },
      resolved.status
    )
  }
  return appendAndAnswer(c, pool, resolved.operation)
}

/** Append one resolved operation and answer the event that the log holds (I1, I4). */
async function appendAndAnswer(c: Context, pool: Pool, operation: Operation) {
  await appendOperation(pool, operation)
  const event = await readEventByOperation(pool, operation.id)
  if (event === undefined) throw new Error('the appended event is missing from the log (I4)')
  return c.json(event, 201)
}

/**
 * The team membership that a target resolves through (AS-4, #222): the
 * `team_members` projection, with the engine's own team projection as the
 * fallback that a store without the rows still answers. A team that neither
 * holds resolves to nobody, so the engine routes to the Unroutable queue (I10).
 */
async function teamMembersFor(
  pool: Pool,
  log: Log
): Promise<ReadonlyMap<string, readonly string[]>> {
  const members = new Map<string, string[]>()
  for (const team of teamsOf(log)) members.set(team.name, [...team.members])
  for (const [team, principals] of await readTeamMembers(pool)) {
    const held = members.get(team) ?? []
    members.set(team, [...new Set([...held, ...principals])])
  }
  return members
}

/**
 * The group directory of one request (AS-1, I10, #252): the Keycloak groups
 * that the Admin API lists, mapped from the group id that a target names to
 * the ids of the members it holds now. The map is built once per request, like
 * `teamMembersFor`, so a re-resolution in the same request reads one snapshot.
 */
async function groupMembersFor(config: Config): Promise<ReadonlyMap<string, readonly string[]>> {
  const groups = await listDirectoryGroups(config)
  return new Map(groups.map((group) => [group.id, group.members.map((member) => member.id)]))
}

/**
 * The target resolver of one request, with both directory reads (AS-4, #252).
 * The team projection comes from the log and the `team_members` rows, and the
 * group membership comes from Keycloak through the service account. A read
 * refreshes the live targets only, so the seam carries the deprovisioned
 * accounts (ID-5) and reads no manager.
 */
async function resolverForRequest(
  config: Config,
  pool: Pool,
  log: Log,
  starter: string | undefined,
  data: Readonly<Record<string, unknown>>
): Promise<TargetResolver> {
  const teamMembers = await teamMembersFor(pool, log)
  const groupMembers = await groupMembersFor(config)
  return resolverFor(starter, data, teamMembers, groupMembers, await directoryFor(config, log, []))
}

/** The group ids the claimed task's current step names (AS-4, #267), so the claim refreshes those alone. */
function claimedGroups(log: Log, body: Record<string, unknown>): readonly string[] {
  const payload = isRecord(body.payload) ? body.payload : {}
  const instanceId = payload.instanceId
  const instance = typeof instanceId === 'string' ? instanceOf(log, instanceId) : undefined
  if (instance === undefined) return []
  return instance.assignees
    .filter((assignee) => assignee.step === instance.currentStep && 'group' in assignee.target)
    .map((assignee) => ('group' in assignee.target ? assignee.target.group : ''))
    .filter((group) => group !== '')
}

/**
 * The starters whose manager a routing intent may need (AS-1, #267): the
 * actor of a start, or the starter of the instance the intent names. A claim
 * resolves only live targets and names none.
 */
function routingStarters(
  log: Log,
  body: Record<string, unknown>,
  actor: string
): readonly (string | undefined)[] {
  if (body.type === STEP_CLAIMED) return []
  if (body.type === INSTANCE_STARTED) return [actor]
  const payload = isRecord(body.payload) ? body.payload : {}
  const instanceId = payload.instanceId
  return typeof instanceId === 'string' ? [instanceOf(log, instanceId)?.starter] : []
}

/** A string payload value, or undefined when it is another type. */
function _stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** One inbox item as the API returns it (VT-1, VT-2, S14). */
type InboxItem = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly state: string
  readonly holder?: string
  /** The deadline of the task, from its escalation timer (VT-1, VT-2, SE-4); absent when the step sets none. */
  readonly dueAt?: number
  readonly lastActivityAt: number
}

/**
 * Read the tab that a request names (VT-1). An absent tab is `my`, as the
 * contract declares; any other value is refused rather than guessed.
 */
function readInboxTab(value: string | undefined): InboxTab | undefined {
  if (value === undefined || value === '') return 'my'
  return value === 'my' || value === 'available' || value === 'started' ? value : undefined
}

/**
 * Map a task row and the instance status to the contract's inbox state
 * (VT-2, AS-2). The task projection records `available`, `opened` and
 * `completed`; the instance status answers when the current step has no task
 * row yet. A projection that records `skipped` or `sent-back` keeps that state
 * for the API even though this lane writes neither.
 */
function inboxState(taskState: string | null, instanceStatus: string): string {
  switch (taskState) {
    case 'available':
      return 'unopened'
    case 'opened':
      return 'opened'
    case 'completed':
      return 'completed'
    case 'skipped':
      return 'skipped'
    case 'sent-back':
      return 'sent-back'
    default:
      if (instanceStatus === 'draft') return 'draft'
      return instanceStatus === 'in-progress' ? 'opened' : 'unopened'
  }
}

/** Start the HTTP server on the configured address and return a drain handle. */
export async function serveHttp(config: Config): Promise<ServedHttp> {
  const pool = createPool(config.databaseUrl)
  const hub = createHub()
  const app = createApp(config, pool, hub)
  const { hostname, port } = listenAddress(config)
  const server = serve({ fetch: app.fetch, hostname, port })
  // The WebSocket channel rides the same server (RT-1), and this process
  // follows the log so a write by any process reaches its subscribers.
  attachRealtime(server as Server, hub)
  const stopFollowing = await followLog(hub, pool)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    port: boundPort,
    close: async () => {
      await stopFollowing()
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
  return authenticateHeaders(c.req.raw.headers, pool, config)
}

/**
 * Resolve the credential that a set of headers carries (ADR 0012, #260): the
 * bearer token, else the session cookie. A request and a WebSocket upgrade
 * authenticate the same way.
 */
async function authenticateHeaders(
  headers: Headers,
  pool: Pool,
  config: Config
): Promise<Auth | undefined> {
  const authorization = headers.get('authorization') ?? undefined
  if (authorization?.toLowerCase().startsWith('bearer ') === true) {
    const token = authorization.slice('bearer '.length).trim()
    // #224: an empty bearer header is not a credential. The browser sends the
    // session cookie, and the generated client omits the header when it has no
    // token; a request that still carries an empty one falls through to the
    // cookie instead of failing before it reaches it.
    if (token === '') return authenticateCookie(headers, pool, config)
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

  return authenticateCookie(headers, pool, config)
}

/** Resolve the session cookie to one principal and one session row (ADR 0012, #224). */
async function authenticateCookie(
  headers: Headers,
  pool: Pool,
  config: Config
): Promise<Auth | undefined> {
  const sessionId = cookieValue(headers.get('cookie'), config.session.cookieName)
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

/** The value of one cookie in a Cookie header, or undefined when it is absent. */
function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
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

/** Whether a principal may read a flow, its draft or its publication (#220, I8). */
function mayReadFlow(grants: readonly Grant[], slug: string): boolean {
  return FLOW_READ_SCOPES.some((scope) => authorize(grants, scope, `flow:${slug}`))
}

/** Whether a principal may read the draft of a flow (#220, DF-3, DF-5, I8). */
function mayReadDraft(grants: readonly Grant[], slug: string): boolean {
  return ['flow.read', 'flow.edit', 'flow.build'].some((scope) =>
    authorize(grants, scope, `flow:${slug}`)
  )
}

/** The change class from the current draft to the next one (#220, DF-5). */
function changesForPush(flow: Flow, definition: FlowDefinition): readonly DefinitionChange[] {
  return flow.draft === undefined
    ? [{ class: 'structural', message: 'the first draft was created', path: '/' }]
    : classifyChange(flow.draft, definition)
}

/** The change class from the newest publication to the draft (#220, DF-5). */
function changesForPublish(flow: Flow): readonly DefinitionChange[] {
  const latest = flow.versions[flow.versions.length - 1]
  return latest === undefined
    ? [{ class: 'structural', message: 'the first publication created the flow', path: '/' }]
    : classifyChange(latest.definition, flow.draft ?? latest.definition)
}

/**
 * Whether the acting principal may make a classified change (#220, DF-5, D2).
 * A structural change needs `flow.build`; an edit-class change needs
 * `flow.edit` or `flow.build`.
 */
function changeAllowed(
  grants: readonly Grant[],
  slug: string,
  changes: readonly DefinitionChange[]
): boolean {
  const resource = `flow:${slug}`
  if (changes.some((change) => change.class === 'structural')) {
    return authorize(grants, 'flow.build', resource)
  }
  return authorize(grants, 'flow.edit', resource) || authorize(grants, 'flow.build', resource)
}

/** The reason that a flow change needs a scope, in plain language (#220). */
function refusalFor(slug: string, changes: readonly DefinitionChange[]): string {
  const resource = `flow:${slug}`
  return changes.some((change) => change.class === 'structural')
    ? `the change is structural; it requires the scope flow.build on ${resource}`
    : `the change is edit-class; it requires the scope flow.edit on ${resource}`
}

/** Whether a state-changing request carries the cookie session's CSRF token (ADR 0012). */
function csrfOk(c: Context, auth: Auth): boolean {
  return auth.kind !== 'cookie' || c.req.header('x-csrf-token') === auth.session.csrfToken
}

/** One 403 body for a state-changing request without its CSRF token (ADR 0012). */
function csrfRefused(c: Context) {
  return c.json({ error: 'the CSRF token is missing or invalid' }, 403)
}

/** Read a JSON object body, or undefined when the body is not one (#220). */
async function readJsonObject(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await c.req.json()
    return isRecord(body) ? body : undefined
  } catch {
    return undefined
  }
}

/** Read the body of `POST /api/v1/admin/users` (#228, #267, ID-6, AS-1). */
function readCreateUser(
  body: Record<string, unknown>
): { email: string; displayName: string; sendInvite: boolean; managerId?: string } | undefined {
  const { email, displayName, sendInvite, groups, managerId } = body
  if (typeof email !== 'string' || !email.includes('@')) return undefined
  if (typeof displayName !== 'string' || displayName.trim() === '') return undefined
  if (typeof sendInvite !== 'boolean') return undefined
  if (
    groups !== undefined &&
    (!Array.isArray(groups) || !groups.every((group) => typeof group === 'string' && group !== ''))
  ) {
    return undefined
  }
  if (managerId !== undefined && (typeof managerId !== 'string' || managerId.trim() === '')) {
    return undefined
  }
  return {
    email: email.trim(),
    displayName: displayName.trim(),
    sendInvite,
    ...(typeof managerId === 'string' ? { managerId: managerId.trim() } : {}),
  }
}

/** Read the body of `POST /api/v1/flows` (#220). */
function readCreateFlow(
  body: Record<string, unknown>
): { slug: string; title?: string } | undefined {
  const { slug, title } = body
  if (typeof slug !== 'string' || slug.trim() === '' || slug.includes('/')) return undefined
  if (title !== undefined && typeof title !== 'string') return undefined
  return { slug, ...(title === undefined ? {} : { title }) }
}

/** Read the body of `PUT /api/v1/flows/{slug}/draft` (#220, I5). */
function readDraftWrite(
  body: Record<string, unknown>
): { version: number; definition: unknown; baseHash?: string } | undefined {
  const { version, definition, baseHash } = body
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  if (!isRecord(definition)) return undefined
  if (baseHash !== undefined && (typeof baseHash !== 'string' || baseHash === '')) return undefined
  return { version, definition, ...(baseHash === undefined ? {} : { baseHash }) }
}

/** Read the body of `POST /api/v1/flows/{slug}/publish` (#220, I5). */
function readPublish(body: Record<string, unknown>): { version: number } | undefined {
  const { version } = body
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  return { version }
}

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One 401 body, the same shape for every credential (ADR 0012). */
function unauthorized(c: Context) {
  return c.json({ error: 'there is no session; sign in first' }, 401)
}

/** Whether a read asked for the flow's configuration changes (VT-5). */
function includesChanges(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

/** A query value that names something, or undefined for an absent or empty one. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * One point of a flow's history from a query parameter (DF-6, #264): a
 * positive version number or `draft`; absent gives undefined, anything else
 * gives null.
 */
function versionRefOf(value: string | undefined): VersionRef | undefined | null {
  const text = nonEmpty(value)
  if (text === undefined) return undefined
  if (text === 'draft') return 'draft'
  const number = Number(text)
  return Number.isInteger(number) && number >= 1 ? number : null
}

/** The filename of an instance PDF: the flow, the instance and the step, ASCII and safe (OU-1). */
function pdfFilename(flow: string, instanceId: string, step: string): string {
  const safe = (value: string): string =>
    value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'instance'
  return `enform-${safe(flow)}-${safe(instanceId)}-${safe(step)}.pdf`
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
