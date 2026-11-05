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
import { authorize, type Grant } from '../engine/authorize.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { classifyChange, type DefinitionChange } from '../engine/edit.js'
import {
  changeTitle,
  createFlow,
  type Flow,
  publish,
  publishedByHash,
  publishedFlow,
  push,
  STARTER_DEFINITION,
} from '../engine/flow.js'
import { instanceOf, readInstance, readInstanceStep } from '../engine/instances.js'
import type { Log, Operation, OperationDeps } from '../engine/operation.js'
import { renderInstancePdf } from '../engine/pdf.js'
import type { TargetResolver } from '../engine/routing.js'
import { mayRead } from '../engine/status.js'
import { teamsOf } from '../engine/teams.js'
import { flowOf, isConfigChange, timeline, timelineFor } from '../engine/timeline.js'
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
  endIdpSession,
  groupIds,
  listDirectoryGroups,
  listDirectoryUsers,
  oidcConfiguration,
  principalFromToken,
  tokenExpiry,
} from './keycloak.js'
import { mountInterface } from './static.js'
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

  // Issue #224: the app and the API share one origin. The interface is
  // registered before the API routes, so `/app/*` and `/client/*` never cover
  // `/api/v1`, `/healthz`, `/readyz` or `/version`.
  mountInterface(app)

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
  app.get('/api/v1/admin/groups', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    if (!authorize(grants, 'org.grants', 'org')) {
      return c.json({ error: 'the principal may not read the directory' }, 403)
    }
    return c.json(await listDirectoryGroups(config))
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
      })
      return c.json(
        {
          id: created.id,
          displayName: input.displayName,
          email: input.email,
          status: 'active',
          groups: [],
          temporaryPassword: created.temporaryPassword,
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
    return c.json({ slug, version: stored.draftVersion, definition: stored.flow.draft })
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
    const grants = await grantsOfPrincipal(pool, auth.principal.id)
    const changes = changesForPush(stored.flow, definition)
    if (!changeAllowed(grants, slug, changes)) {
      return c.json({ error: refusalFor(slug, changes) }, 403)
    }
    const pushed = push(stored.flow, definition, operationDeps, auth.principal.id, grants)
    await appendOperation(pool, pushed.operation)
    return c.json({
      slug,
      version: stored.draftVersion,
      definition: pushed.flow.draft ?? definition,
    })
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
    const published = publishedFlow(await readLog(pool), slug)
    if (published === undefined || (await readFlowProjection(pool, slug)) === undefined) {
      return c.json({ error: `no published flow has the slug ${slug}` }, 404)
    }
    return c.json({
      slug,
      version: published.version,
      contentHash: published.contentHash,
      definition: published.definition,
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

  app.get('/api/v1/log', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    return c.json(await readLog(pool))
  })

  app.get('/api/v1/state', async (c) => {
    const auth = await authenticate(c, pool, config)
    if (auth === undefined) return unauthorized(c)
    const log = await readLog(pool)
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
    const log = await readLog(pool)
    const instance = instanceOf(log, instanceId)
    if (instance === undefined) {
      return c.json({ error: 'the log holds no such instance' }, 404)
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
  const log = await readLog(pool)
  // The directory is read once per request (AS-4, #252): the team projection
  // and the Keycloak groups, so every resolution in this request reads one
  // snapshot. The resolver itself is pure (server/intents.ts).
  const teamMembers = await teamMembersFor(pool, log)
  const groupMembers = await groupMembersFor(config)
  const resolved = resolveClientOperation(
    {
      log,
      principal: auth.principal,
      grants: grantsFor(log, auth.principal),
      resolver: (starter, data) => resolverFor(starter, data, teamMembers, groupMembers),
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
 * group membership comes from Keycloak through the service account.
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
  return resolverFor(starter, data, teamMembers, groupMembers)
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
      return instanceStatus === 'in-progress' ? 'opened' : 'unopened'
  }
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
    // #224: an empty bearer header is not a credential. The browser sends the
    // session cookie, and the generated client omits the header when it has no
    // token; a request that still carries an empty one falls through to the
    // cookie instead of failing before it reaches it.
    if (token === '') return authenticateCookie(c, pool, config)
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

  return authenticateCookie(c, pool, config)
}

/** Resolve the session cookie to one principal and one session row (ADR 0012, #224). */
async function authenticateCookie(
  c: Context,
  pool: Pool,
  config: Config
): Promise<Auth | undefined> {
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
    ? [{ class: 'structural', message: 'the first draft was created' }]
    : classifyChange(flow.draft, definition)
}

/** The change class from the newest publication to the draft (#220, DF-5). */
function changesForPublish(flow: Flow): readonly DefinitionChange[] {
  const latest = flow.versions[flow.versions.length - 1]
  return latest === undefined
    ? [{ class: 'structural', message: 'the first publication created the flow' }]
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

/** Read the body of `POST /api/v1/admin/users` (#228, ID-6). */
function readCreateUser(
  body: Record<string, unknown>
): { email: string; displayName: string; sendInvite: boolean } | undefined {
  const { email, displayName, sendInvite, groups } = body
  if (typeof email !== 'string' || !email.includes('@')) return undefined
  if (typeof displayName !== 'string' || displayName.trim() === '') return undefined
  if (typeof sendInvite !== 'boolean') return undefined
  if (
    groups !== undefined &&
    (!Array.isArray(groups) || !groups.every((group) => typeof group === 'string' && group !== ''))
  ) {
    return undefined
  }
  return { email: email.trim(), displayName: displayName.trim(), sendInvite }
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
): { version: number; definition: unknown } | undefined {
  const { version, definition } = body
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  if (!isRecord(definition)) return undefined
  return { version, definition }
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
