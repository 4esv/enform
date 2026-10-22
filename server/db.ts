// Issue #216, I1, I2, I4, I5, I14, ADR 0004, ADR 0012, ADR 0013: the thin SQL
// layer over PostgreSQL. `events` is the append-only log and every other table
// is a projection of it, except `sessions` and `oidc_attempts`, which are
// operational state that expires (ADR 0013). A write appends the event, updates
// the projections its type feeds and commits in one transaction (I2); a retry
// with the same operation id writes nothing (I1).

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client, escapeIdentifier, Pool, type PoolClient } from 'pg'
import type { Grant } from '../engine/authorize.js'
import { GRANT_CHANGE_TYPE } from '../engine/grants.js'
import type { Event, Operation } from '../engine/operation.js'
import { newCsrfToken, newOperationId, newStateId } from './ids.js'

/** The event that records a change to the profile cache (ID-4, ADR 0012). */
export const PRINCIPAL_UPDATED_TYPE = 'identity.principal.updated@1'

/** One cached directory profile. `id` is the Keycloak subject (ID-4). */
export type Principal = {
  readonly id: string
  readonly displayName: string
  readonly email?: string
  readonly groups: readonly string[]
}

/** One server-side session row (ADR 0012). */
export type SessionRow = {
  readonly id: string
  readonly principalId: string
  readonly csrfToken: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  readonly revokedAt: number | null
  readonly refreshToken: string | null
}

/** The result of appending one operation: whether it was new, and its sequence. */
export type AppendResult = { readonly inserted: boolean; readonly seq: number | null }

/** Create the connection pool that the server and the worker share. */
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 })
}

/** Create the database that a URL names, when it does not exist (DE-1). */
export async function createDatabaseIfMissing(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (name === '') throw new Error('the database URL names no database')
  const adminUrl = new URL(databaseUrl)
  adminUrl.pathname = '/postgres'
  const client = new Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    const found = await client.query('select 1 from pg_database where datname = $1', [name])
    if (found.rowCount === 0) {
      // `CREATE DATABASE` takes an identifier, not a bind parameter (DE-1).
      const statement = ['create database', escapeIdentifier(name)].join(' ')
      await client.query(statement)
    }
  } finally {
    await client.end()
  }
}

/** Apply every migration that the database does not have, each in one transaction. */
export async function runMigrations(pool: Pool): Promise<readonly string[]> {
  const versions = migrationFiles()
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      'create table if not exists schema_migrations (version text primary key, applied_at bigint not null)'
    )
    const applied = await client.query<{ version: string }>('select version from schema_migrations')
    const done = new Set(applied.rows.map((row) => row.version))
    for (const file of versions) {
      if (done.has(file.version)) continue
      await client.query(readFileSync(file.path, 'utf8'))
      await client.query('insert into schema_migrations (version, applied_at) values ($1, $2)', [
        file.version,
        Date.now(),
      ])
    }
    await client.query('commit')
    return versions.map((file) => file.version)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** The applied and pending migration versions (DE-5, ADR 0011). */
export async function migrationStatus(
  pool: Pool
): Promise<{ readonly applied: readonly string[]; readonly pending: readonly string[] }> {
  const versions = migrationFiles().map((file) => file.version)
  try {
    const result = await pool.query<{ version: string }>('select version from schema_migrations')
    const applied = new Set(result.rows.map((row) => row.version))
    return {
      applied: versions.filter((version) => applied.has(version)),
      pending: versions.filter((version) => !applied.has(version)),
    }
  } catch (error) {
    if (isMissingTable(error)) return { applied: [], pending: versions }
    throw error
  }
}

/**
 * Append one operation and update the projections that its type feeds, in one
 * transaction (I2). A second append of the same operation ID writes nothing
 * (I1). The event keeps the operation's ID, time and actor (I4, I14).
 */
export async function appendOperation(pool: Pool, operation: Operation): Promise<AppendResult> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await client.query<{ seq: string }>(
      `insert into events (operation_id, type, at, actor, payload)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (operation_id) do nothing
       returning seq`,
      [
        operation.id,
        operation.type,
        operation.at,
        operation.actor ?? null,
        JSON.stringify(operation.payload),
      ]
    )
    const seq = result.rows[0]?.seq
    if (seq !== undefined) {
      await projectEvent(client, {
        seq: Number(seq),
        operationId: operation.id,
        type: operation.type,
        at: operation.at,
        actor: operation.actor,
        payload: operation.payload,
      })
    }
    await client.query('commit')
    return { inserted: seq !== undefined, seq: seq === undefined ? null : Number(seq) }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Rebuild every projection from the log (I4, ADR 0013). Sessions and OIDC
 * attempts are operational state, so they survive; every derived row is
 * truncated and folded back in sequence order.
 */
export async function rebuild(pool: Pool): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(
      'truncate grants, principals, flows, flow_versions, instances, tasks, teams, team_members, outbox, timers'
    )
    const events = await client.query<{
      seq: string
      operation_id: string
      type: string
      at: string
      actor: string | null
      payload: Record<string, unknown>
    }>('select seq, operation_id, type, at, actor, payload from events order by seq')
    for (const row of events.rows) {
      await projectEvent(client, {
        seq: Number(row.seq),
        operationId: row.operation_id,
        type: row.type,
        at: Number(row.at),
        actor: row.actor ?? undefined,
        payload: row.payload,
      })
    }
    await client.query('commit')
    return events.rowCount ?? events.rows.length
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** The grants that one principal holds (AC-1, I8). */
export async function grantsOfPrincipal(pool: Pool, principal: string): Promise<readonly Grant[]> {
  const result = await pool.query<{ principal: string; resource: string; scopes: string[] }>(
    'select principal, resource, scopes from grants where principal = $1 order by seq',
    [principal]
  )
  return result.rows.map((row) => ({
    principal: row.principal,
    resource: row.resource,
    scopes: row.scopes,
  }))
}

/** Whether the projection already holds one grant, so `init` stays idempotent. */
export async function hasGrant(pool: Pool, grant: Grant): Promise<boolean> {
  const result = await pool.query(
    'select 1 from grants where principal = $1 and resource = $2 and scopes = $3::text[]',
    [grant.principal, grant.resource, grant.scopes]
  )
  return result.rowCount !== 0
}

/**
 * Cache one directory profile and record the change on the log, so a rebuild
 * derives the cache (I4, ADR 0012). An unchanged profile writes no event.
 */
export async function upsertPrincipal(pool: Pool, principal: Principal): Promise<void> {
  const existing = await principalById(pool, principal.id)
  if (
    existing !== undefined &&
    existing.displayName === principal.displayName &&
    existing.email === principal.email &&
    existing.groups.length === principal.groups.length &&
    existing.groups.every((group, index) => group === principal.groups[index])
  ) {
    return
  }
  const at = Date.now()
  await appendOperation(pool, {
    id: newOperationId(at),
    type: PRINCIPAL_UPDATED_TYPE,
    at,
    actor: principal.id,
    payload: {
      id: principal.id,
      displayName: principal.displayName,
      ...(principal.email === undefined ? {} : { email: principal.email }),
      groups: principal.groups,
    },
  })
}

/** The cached profile of one principal, or undefined. */
export async function principalById(pool: Pool, id: string): Promise<Principal | undefined> {
  const result = await pool.query<{
    id: string
    display_name: string
    email: string | null
    groups: string[]
  }>('select id, display_name, email, groups from principals where id = $1', [id])
  const row = result.rows[0]
  if (row === undefined) return undefined
  return {
    id: row.id,
    displayName: row.display_name,
    ...(row.email === null ? {} : { email: row.email }),
    groups: row.groups ?? [],
  }
}

/**
 * Create or reuse the session row for a bearer token. The row is keyed by the
 * token hash, so two requests with one token share the session (ADR 0012), and
 * its absolute expiry is the token's expiry.
 */
export async function upsertBearerSession(
  pool: Pool,
  input: {
    readonly principalId: string
    readonly tokenHash: string
    readonly expiresAt: number
    readonly at: number
  }
): Promise<SessionRow> {
  const result = await pool.query<SessionRecord>(
    `insert into sessions (id, principal_id, token_hash, csrf_token, created_at, expires_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $5)
     on conflict (token_hash) do update
       set principal_id = excluded.principal_id,
           expires_at = excluded.expires_at,
           last_seen_at = excluded.last_seen_at
     returning id, principal_id, csrf_token, created_at, expires_at, last_seen_at, revoked_at, refresh_token`,
    [newStateId(16), input.principalId, input.tokenHash, newCsrfToken(), input.at, input.expiresAt]
  )
  return sessionRow(result.rows[0])
}

/** Create one browser session after the callback exchanged the code (ADR 0012). */
export async function createBrowserSession(
  pool: Pool,
  input: {
    readonly principalId: string
    readonly at: number
    readonly expiresAt: number
    readonly refreshToken?: string
  }
): Promise<SessionRow> {
  const result = await pool.query<SessionRecord>(
    `insert into sessions (id, principal_id, csrf_token, created_at, expires_at, last_seen_at, refresh_token)
     values ($1, $2, $3, $4, $5, $4, $6)
     returning id, principal_id, csrf_token, created_at, expires_at, last_seen_at, revoked_at, refresh_token`,
    [
      newStateId(32),
      input.principalId,
      newCsrfToken(),
      input.at,
      input.expiresAt,
      input.refreshToken ?? null,
    ]
  )
  return sessionRow(result.rows[0])
}

/** Read one session by its opaque id, revoked or not. */
export async function sessionById(pool: Pool, id: string): Promise<SessionRow | undefined> {
  const result = await pool.query<SessionRecord>(
    `select id, principal_id, csrf_token, created_at, expires_at, last_seen_at, revoked_at, refresh_token
     from sessions where id = $1`,
    [id]
  )
  return result.rows[0] === undefined ? undefined : sessionRow(result.rows[0])
}

/** Record that a session was used, for the idle timeout (ADR 0012). */
export async function touchSession(pool: Pool, id: string, at: number): Promise<void> {
  await pool.query('update sessions set last_seen_at = $2 where id = $1', [id, at])
}

/** Revoke one session row, so its cookie stops authenticating at once (ID-5). */
export async function revokeSession(
  pool: Pool,
  id: string,
  at: number
): Promise<SessionRow | undefined> {
  const result = await pool.query<SessionRecord>(
    `update sessions set revoked_at = $2
     where id = $1 and revoked_at is null
     returning id, principal_id, csrf_token, created_at, expires_at, last_seen_at, revoked_at, refresh_token`,
    [id, at]
  )
  return result.rows[0] === undefined ? undefined : sessionRow(result.rows[0])
}

/** Store the state, verifier and return path of one sign-in attempt (ADR 0012). */
export async function createOidcAttempt(
  pool: Pool,
  input: {
    readonly state: string
    readonly codeVerifier: string
    readonly returnTo: string
    readonly at: number
    readonly expiresAt: number
  }
): Promise<void> {
  await pool.query(
    `insert into oidc_attempts (state, code_verifier, return_to, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [input.state, input.codeVerifier, input.returnTo, input.at, input.expiresAt]
  )
}

/** Take one sign-in attempt. It is single-use, so a replayed state is refused. */
export async function takeOidcAttempt(
  pool: Pool,
  state: string
): Promise<{ readonly codeVerifier: string; readonly returnTo: string } | undefined> {
  const result = await pool.query<{
    code_verifier: string
    return_to: string
    expires_at: string
  }>(
    `delete from oidc_attempts where state = $1
     returning code_verifier, return_to, expires_at`,
    [state]
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  if (Number(row.expires_at) <= Date.now()) return undefined
  return { codeVerifier: row.code_verifier, returnTo: row.return_to }
}

/** Update the projections that one event feeds. A type this slice does not read projects nothing. */
async function projectEvent(client: PoolClient, event: Event): Promise<void> {
  if (event.type === GRANT_CHANGE_TYPE) {
    const grant = readGrant(event)
    await client.query(
      `insert into grants (principal, resource, scopes, seq)
       values ($1, $2, $3::text[], $4)
       on conflict (principal, resource, scopes) do update set seq = excluded.seq`,
      [grant.principal, grant.resource, grant.scopes, event.seq]
    )
    return
  }
  if (event.type === PRINCIPAL_UPDATED_TYPE) {
    const principal = readPrincipal(event)
    await client.query(
      `insert into principals (id, display_name, email, groups, seq)
       values ($1, $2, $3, $4::jsonb, $5)
       on conflict (id) do update
         set display_name = excluded.display_name,
             email = excluded.email,
             groups = excluded.groups,
             seq = excluded.seq`,
      [
        principal.id,
        principal.displayName,
        principal.email ?? null,
        JSON.stringify(principal.groups),
        event.seq,
      ]
    )
  }
}

/** Read one grant from a `config.grant.changed@1` event. */
function readGrant(event: Event): Grant {
  const { principal, scopes, resource } = event.payload
  if (typeof principal !== 'string' || typeof resource !== 'string' || !isStringArray(scopes)) {
    throw new Error(`events: malformed ${GRANT_CHANGE_TYPE} payload at seq ${event.seq}`)
  }
  return { principal, scopes, resource }
}

/** Read one profile from an `identity.principal.updated@1` event. */
function readPrincipal(event: Event): Principal {
  const { id, displayName, email, groups } = event.payload
  if (typeof id !== 'string' || typeof displayName !== 'string') {
    throw new Error(`events: malformed ${PRINCIPAL_UPDATED_TYPE} payload at seq ${event.seq}`)
  }
  return {
    id,
    displayName,
    ...(typeof email === 'string' ? { email } : {}),
    groups: isStringArray(groups) ? groups : [],
  }
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** The columns of one session row. */
type SessionRecord = {
  readonly id: string
  readonly principal_id: string
  readonly csrf_token: string
  readonly created_at: string
  readonly expires_at: string
  readonly last_seen_at: string
  readonly revoked_at: string | null
  readonly refresh_token: string | null
}

/** Map one session row, turning the bigint columns into milliseconds. */
function sessionRow(row: SessionRecord): SessionRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    csrfToken: row.csrf_token,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    refreshToken: row.refresh_token,
  }
}

/** The migration files, in version order. */
function migrationFiles(): readonly { version: string; path: string }[] {
  const dir = migrationsDirectory()
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ version: name.slice(0, -'.sql'.length), path: `${dir}/${name}` }))
}

/**
 * The migration directory. A source checkout keeps it beside `server/db.ts`;
 * the release image copies `server/migrations` beside `dist/`.
 */
function migrationsDirectory(): string {
  for (const candidate of ['./migrations', '../../server/migrations']) {
    const path = fileURLToPath(new URL(`${candidate}/`, import.meta.url))
    try {
      if (readdirSync(path).length >= 0) return path
    } catch {
      // Try the next layout.
    }
  }
  throw new Error('server: cannot find the migration directory')
}

/** Whether an error is PostgreSQL's "relation does not exist". */
function isMissingTable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42P01'
  )
}
