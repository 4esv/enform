// Issue #216, I1, I2, I4, I5, I14, ADR 0004, ADR 0012, ADR 0013: the thin SQL
// layer over PostgreSQL. `events` is the append-only log and every other table
// is a projection of it, except `sessions` and `oidc_attempts`, which are
// operational state that expires (ADR 0013). A write appends the event, updates
// the projections its type feeds and commits in one transaction (I2); a retry
// with the same operation id writes nothing (I1).
//
// Issue #220, DF-1, DF-2, DF-4: `flows` and `flow_versions` project the flow
// lifecycle. A definition change names its flow, a publication names its slug,
// and the title change names its flow, so a rebuild folds the draft, the list
// and the published versions from the log alone (I4).

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client, escapeIdentifier, Pool, type PoolClient } from 'pg'
import { nextStep, STEP_CLAIMED, STEP_COMPLETED } from '../engine/action.js'
import type { Grant } from '../engine/authorize.js'
import {
  DEFINITION_CHANGED,
  type FlowDefinition,
  type FlowStep,
  parse,
} from '../engine/definition.js'
import { DEFINITION_PUBLISHED, FLOW_TITLE, type Flow } from '../engine/flow.js'
import { GRANT_CHANGE_TYPE } from '../engine/grants.js'
import type { Assignee } from '../engine/instance.js'
import { contentHash, mergeAssignees } from '../engine/instance.js'
import type { Event, Operation } from '../engine/operation.js'
import { type OutboxEntry, outboxOfEvent } from '../engine/outbox.js'
import {
  assigneesAddedBy,
  ESCALATION_EMAIL,
  escalationAddsOfEvent,
  MINUTE_MS,
  REMINDER_EMAIL,
  TIMER_FIRED,
} from '../engine/reminders.js'
import { STEP_SENT_BACK } from '../engine/sendBack.js'
import { EMAIL_CONNECTOR, INSTANCE_STARTED, INSTANCE_SUBMITTED } from '../engine/submission.js'
import { STEP_TAKEN_OVER } from '../engine/takeover.js'
import { TEAM_CHANGE_TYPE, teamMembership } from '../engine/teams.js'
import { INSTANCE_CANCELLED, INSTANCE_UNDONE, INSTANCE_WITHDRAWN } from '../engine/withdraw.js'
import { newCsrfToken, newOperationId, newStateId } from './ids.js'
import {
  cancelStepTimers,
  scheduleNextReminder,
  scheduleStepTimers,
  timerRecipient,
} from './timers.js'

/** The event that records a change to the profile cache (ID-4, ADR 0012). */
export const PRINCIPAL_UPDATED_TYPE = 'identity.principal.updated@1'

/** One cached directory profile. `id` is the Keycloak subject (ID-4). */
export type Principal = {
  readonly id: string
  readonly displayName: string
  readonly email?: string
  readonly groups: readonly string[]
}

/** One flow in the list, from the `flows` projection (#220, DF-2, DF-4). */
export type FlowSummaryRow = {
  readonly slug: string
  readonly title?: string
  readonly draftVersion: number
  readonly publishedVersion?: number
  readonly updatedAt: number
}

/** The draft and the published versions of one flow, from the projections (#220). */
export type StoredFlow = {
  readonly flow: Flow
  readonly title?: string
  readonly draftVersion: number
  readonly updatedAt: number
}

/** One inbox tab (VT-1). */
export type InboxTab = 'my' | 'available' | 'started'

/**
 * One row of the inbox, from the `instances` and `tasks` projections (VT-1,
 * VT-2, S14). `taskState` is the projection's task state; `instanceStatus` is
 * the instance's status, which the API maps to an inbox state when a current
 * step has no task row. `lastActivityAt` is the newest event on the instance.
 */
export type InboxRow = {
  readonly instanceId: string
  readonly flowSlug: string
  readonly step: string
  readonly taskState: string | null
  readonly instanceStatus: string
  readonly holder: string | null
  readonly dueAt: number | null
  readonly lastActivityAt: number
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

/** The event that records a seed profile clear (DE-4, I14). It is internal: no interface reads it. */
export const SEED_CLEARED_TYPE = 'seed.cleared@1'

/** One kind of record that a seed profile created (DE-4). */
export type SeedRecordKind = 'user' | 'group' | 'team' | 'flow' | 'instance' | 'grant'

/** One record that a seed profile created, marked in `seed_records` (DE-4). */
export type SeedRecord = {
  readonly profile: string
  readonly kind: SeedRecordKind
  readonly id: string
  readonly createdAt: number
  readonly clearedAt: number | null
}

/** A seed record before it is stored. */
export type NewSeedRecord = {
  readonly profile: string
  readonly kind: SeedRecordKind
  readonly id: string
  readonly createdAt: number
}

/** The result of appending a seed run: the operations and their records. */
export type SeedAppendResult = {
  readonly operations: number
  readonly records: number
}

/** The events that rebuild derived state from the log (I4, DE-4). */
export type SeedClearResult = {
  readonly records: readonly SeedRecord[]
  readonly operationId: string
}

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
    const result = await appendOperationIn(client, operation)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Append one operation and fold its projection inside an open transaction (I2, I4). */
async function appendOperationIn(client: PoolClient, operation: Operation): Promise<AppendResult> {
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
  return { inserted: seq !== undefined, seq: seq === undefined ? null : Number(seq) }
}

/**
 * Claim and fire the due timers of every task in one transaction each (SE-3,
 * SE-4, SE-5, I2, I3). The claim is `for update skip locked`, so two workers
 * never fire the same timer, and the `timer.fired@1` event and the fired mark
 * commit together: a crash before the commit leaves the timer due, and a crash
 * after it leaves the timer fired. The event carries the one outbox entry that
 * the timer stands for, which `projectEvent` inserts in the same transaction.
 * A cancelled, fired or future timer is never claimed.
 */
export async function fireDueTimers(pool: Pool, now: number, limit = 20): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const due = await client.query<{
      id: string
      kind: 'reminder' | 'escalation'
      fire_at: string
      instance_id: string
      step: string
      payload: Record<string, unknown>
    }>(
      `select id, kind, fire_at, instance_id, step, payload
       from timers
       where cancelled_at is null and fired_at is null and fire_at <= $1
       order by fire_at, id
       limit $2
       for update skip locked`,
      [now, limit]
    )
    if (due.rows.length === 0) {
      await client.query('commit')
      return 0
    }
    for (const row of due.rows) {
      const entry: OutboxEntry = {
        operation: row.kind === 'reminder' ? REMINDER_EMAIL : ESCALATION_EMAIL,
        target: EMAIL_CONNECTOR,
        payload: row.payload,
      }
      await appendOperationIn(client, {
        id: `timer:${row.id}`,
        type: TIMER_FIRED,
        at: now,
        payload: {
          timerId: row.id,
          instanceId: row.instance_id,
          step: row.step,
          kind: row.kind,
          fireAt: Number(row.fire_at),
          outbox: [entry],
        },
      })
    }
    await client.query('commit')
    return due.rows.length
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Read one event by the client-created operation id (I1), or undefined when it is absent. */
export async function readEventByOperation(
  pool: Pool,
  operationId: string
): Promise<Event | undefined> {
  const result = await pool.query<{
    seq: string
    operation_id: string
    type: string
    at: string
    actor: string | null
    payload: Record<string, unknown>
  }>('select seq, operation_id, type, at, actor, payload from events where operation_id = $1', [
    operationId,
  ])
  const row = result.rows[0]
  if (row === undefined) return undefined
  return {
    seq: Number(row.seq),
    operationId: row.operation_id,
    type: row.type,
    at: Number(row.at),
    actor: row.actor ?? undefined,
    payload: row.payload,
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
    // The outbox rows are derived state (I4), but their delivery columns are
    // operational state beside the log: a rebuild saves them by the
    // deterministic row id and restores them after the fold, so a delivered
    // row is never queued again and a retry of it stays a no-op (I3, SE-1).
    const delivery = await readOutboxDelivery(client)
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
    // The seed record is operational state beside the log. Re-apply every
    // cleared record after the fold, so a rebuild never resurrects a demo
    // that `enform seed clear` removed (DE-4, I4).
    await deleteClearedSeedProjections(client)
    await restoreOutboxDelivery(client, delivery)
    await client.query('commit')
    return events.rowCount ?? events.rows.length
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Read the append-only log, in order (I4). It is the engine's `Log`. */
export async function readLog(pool: Pool): Promise<readonly Event[]> {
  const result = await pool.query<{
    seq: string
    operation_id: string
    type: string
    at: string
    actor: string | null
    payload: Record<string, unknown>
  }>('select seq, operation_id, type, at, actor, payload from events order by seq')
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    operationId: row.operation_id,
    type: row.type,
    at: Number(row.at),
    actor: row.actor ?? undefined,
    payload: row.payload,
  }))
}

/**
 * Read the records that one seed profile created (DE-4). `liveOnly` reads the
 * records that no clear removed, which is the set that a clear removes and the
 * set that tells a second `seed demo` that a profile is already loaded.
 */
export async function readSeedRecords(
  pool: Pool,
  profile: string,
  liveOnly = false
): Promise<readonly SeedRecord[]> {
  const result = await pool.query<{
    profile: string
    kind: SeedRecordKind
    id: string
    created_at: string
    cleared_at: string | null
  }>(
    `select profile, kind, id, created_at, cleared_at
     from seed_records
     where profile = $1 ${liveOnly ? 'and cleared_at is null' : ''}
     order by created_at, kind, id`,
    [profile]
  )
  return result.rows.map(seedRecordRow)
}

/**
 * Append the operations of one seed run and mark the records it created, in
 * one transaction (DE-4, I2). A seed run is a batch: a failed append leaves
 * neither an event nor a record behind.
 */
export async function appendSeedRun(
  pool: Pool,
  operations: readonly Operation[],
  records: readonly NewSeedRecord[]
): Promise<SeedAppendResult> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const operation of operations) await appendOperationIn(client, operation)
    for (const record of records) {
      await client.query(
        `insert into seed_records (profile, kind, id, created_at)
         values ($1, $2, $3, $4)
         on conflict (profile, kind, id) do nothing`,
        [record.profile, record.kind, record.id, record.createdAt]
      )
    }
    await client.query('commit')
    return { operations: operations.length, records: records.length }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Clear one seed profile: mark every live record cleared, append one
 * `seed.cleared@1` operation and remove the seeded projections (DE-4, I4). The
 * log keeps its events; only derived rows and the Keycloak users that the
 * caller already deleted are gone. The records stay for a rebuild.
 */
export async function clearSeedRecords(
  pool: Pool,
  profile: string,
  at: number,
  actor: string
): Promise<SeedClearResult> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const live = await client.query<{
      profile: string
      kind: SeedRecordKind
      id: string
      created_at: string
      cleared_at: string | null
    }>(
      `select profile, kind, id, created_at, cleared_at
       from seed_records
       where profile = $1 and cleared_at is null
       order by created_at, kind, id
       for update`,
      [profile]
    )
    if (live.rows.length === 0) {
      await client.query('commit')
      return { records: [], operationId: '' }
    }
    await client.query(
      'update seed_records set cleared_at = $2 where profile = $1 and cleared_at is null',
      [profile, at]
    )
    const operation: Operation = {
      id: newOperationId(at),
      type: SEED_CLEARED_TYPE,
      at,
      actor,
      payload: { profile },
    }
    await appendOperationIn(client, operation)
    await client.query('commit')
    return { records: live.rows.map(seedRecordRow), operationId: operation.id }
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Whether a read must hide one entity because `seed clear` removed it (DE-4). */
export async function isClearedSeedRecord(
  pool: Pool,
  kind: SeedRecordKind,
  id: string
): Promise<boolean> {
  const result = await pool.query(
    'select 1 from seed_records where kind = $1 and id = $2 and cleared_at is not null limit 1',
    [kind, id]
  )
  return result.rowCount !== 0
}

/** The ids of one kind that a clear removed, so a list read can exclude them (DE-4). */
export async function clearedSeedIds(
  pool: Pool,
  kind: SeedRecordKind
): Promise<ReadonlySet<string>> {
  const result = await pool.query<{ id: string }>(
    'select id from seed_records where kind = $1 and cleared_at is not null',
    [kind]
  )
  return new Set(result.rows.map((row) => row.id))
}

/** Whether the projection holds a flow with this slug (#220, DF-1). */
export async function flowExists(pool: Pool, slug: string): Promise<boolean> {
  const result = await pool.query('select 1 from flows where slug = $1', [slug])
  return result.rowCount !== 0
}

/**
 * The flows of the installation, newest activity first (#220, DF-1, DF-2,
 * DF-4). The draft version is the version that the current draft would publish
 * as: the newest published version plus one, or 1 when nothing is published.
 * A row with no draft is not a flow that the builder can open, so the list
 * leaves it out.
 */
export async function listFlowSummaries(pool: Pool): Promise<readonly FlowSummaryRow[]> {
  const result = await pool.query<{
    slug: string
    title: string | null
    draft_version: number
    published_version: number | null
    updated_at: string
  }>(
    `select f.slug, f.title, f.draft_version, f.updated_at,
            (select max(v.version) from flow_versions v where v.slug = f.slug) as published_version
     from flows f
     where f.draft is not null
     order by f.updated_at desc, f.slug asc`
  )
  return result.rows.map((row) => ({
    slug: row.slug,
    ...(row.title === null ? {} : { title: row.title }),
    draftVersion: Number(row.draft_version),
    ...(row.published_version === null ? {} : { publishedVersion: Number(row.published_version) }),
    updatedAt: Number(row.updated_at),
  }))
}

/**
 * Read one flow's draft and published versions from the projections (#220,
 * DF-1, DF-2). An unknown slug gives undefined. The definitions go through the
 * engine's parser, so a corrupt row fails with the engine's error.
 */
export async function readFlowProjection(
  pool: Pool,
  slug: string
): Promise<StoredFlow | undefined> {
  const result = await pool.query<{
    title: string | null
    draft: unknown
    draft_version: number
    updated_at: string
  }>('select title, draft, draft_version, updated_at from flows where slug = $1', [slug])
  const row = result.rows[0]
  if (row === undefined) return undefined
  const versions = await pool.query<{
    version: number
    content_hash: string
    definition: unknown
  }>(
    'select version, content_hash, definition from flow_versions where slug = $1 order by version',
    [slug]
  )
  return {
    flow: {
      slug,
      ...(row.draft === null || row.draft === undefined
        ? {}
        : { draft: readStoredDefinition(row.draft, `draft of ${slug}`) }),
      versions: versions.rows.map((version) => ({
        version: version.version,
        contentHash: version.content_hash,
        definition: readStoredDefinition(
          version.definition,
          `version ${version.version} of ${slug}`
        ),
      })),
    },
    ...(row.title === null ? {} : { title: row.title }),
    draftVersion: Number(row.draft_version),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * The members of every team, from the `team_members` projection (AS-6, AS-4).
 * A team that the projection does not hold resolves to nobody, so the engine
 * routes its task to Unroutable (I10).
 */
export async function readTeamMembers(pool: Pool): Promise<ReadonlyMap<string, readonly string[]>> {
  const result = await pool.query<{ team_slug: string; principal: string }>(
    'select team_slug, principal from team_members order by team_slug, principal'
  )
  const members = new Map<string, string[]>()
  for (const row of result.rows) {
    const held = members.get(row.team_slug)
    if (held === undefined) members.set(row.team_slug, [row.principal])
    else held.push(row.principal)
  }
  return members
}

/**
 * Read the candidate rows of one inbox tab (VT-1, VT-2, S14, AS-2, AC-5). The
 * filter is the authorization of the tab: `my` reads the tasks the principal
 * holds, `available` reads the unclaimed tasks whose current step names the
 * principal as an assignee, and `started` reads the open instances the
 * principal started. All three read the current step of an open instance, so a
 * completed, withdrawn or cancelled instance is absent. The API authorizes
 * each row through the engine again (I8).
 */
export async function readInboxRows(
  pool: Pool,
  tab: InboxTab,
  actor: string
): Promise<readonly InboxRow[]> {
  const lastActivity = `coalesce(
    (select max(e.at) from events e where e.payload->>'instanceId' = i.id),
    0
  )`
  const open = `i.current_step is not null and i.done = false
    and i.status in ('waiting', 'in-progress')`
  let query: string
  let values: string[]
  // The due time of the current task, from the escalation timer that the step
  // scheduled (VT-1, VT-2, SE-4): the instance and step scope it, so another
  // instance's timer never leaks. The newest deadline wins after a close and
  // an undo reschedules the task.
  const dueAt = `(select max(tm.fire_at) from timers tm
    where tm.instance_id = i.id
      and tm.step = coalesce(t.step, i.current_step)
      and tm.kind = 'escalation')`
  if (tab === 'available') {
    query = `select t.instance_id, i.flow_slug, t.step, t.state as task_state,
                    i.status as instance_status, t.holder,
                    ${dueAt} as due_at,
                    ${lastActivity} as last_activity_at
             from tasks t
             join instances i on i.id = t.instance_id
             where t.state = 'available'
               and t.holder is null
               and i.current_step = t.step
               and ${open}
               and exists (
                 select 1 from jsonb_array_elements(t.assignees) as a
                 where a->>'step' = t.step and a->'members' ? $1
               )
             order by last_activity_at desc, t.instance_id asc`
    values = [actor]
  } else if (tab === 'started') {
    query = `select i.id as instance_id, i.flow_slug, i.current_step as step,
                    t.state as task_state, i.status as instance_status, t.holder,
                    ${dueAt} as due_at,
                    ${lastActivity} as last_activity_at
             from instances i
             left join tasks t on t.instance_id = i.id and t.step = i.current_step
             where i.starter = $1
               and ${open}
             order by last_activity_at desc, i.id asc`
    values = [actor]
  } else {
    query = `select t.instance_id, i.flow_slug, t.step, t.state as task_state,
                    i.status as instance_status, t.holder,
                    ${dueAt} as due_at,
                    ${lastActivity} as last_activity_at
             from tasks t
             join instances i on i.id = t.instance_id
             where t.holder = $1
               and i.current_step = t.step
               and ${open}
             order by last_activity_at desc, t.instance_id asc`
    values = [actor]
  }
  const result = await pool.query<{
    instance_id: string
    flow_slug: string
    step: string
    task_state: string | null
    instance_status: string
    holder: string | null
    due_at: string | null
    last_activity_at: string
  }>(query, values)
  return result.rows.map((row) => ({
    instanceId: row.instance_id,
    flowSlug: row.flow_slug,
    step: row.step,
    taskState: row.task_state,
    instanceStatus: row.instance_status,
    holder: row.holder,
    dueAt: row.due_at === null ? null : Number(row.due_at),
    lastActivityAt: Number(row.last_activity_at),
  }))
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

/**
 * The grants on one flow and its steps, in log order (#232, AC-1, AC-2): the
 * flow-level grants and the grants whose resource is a step under the flow.
 * The prefix match is exact, so a slug with a wildcard character reads only
 * its own grants. The read is a projection of the log (I4).
 */
export async function grantsOfFlow(pool: Pool, slug: string): Promise<readonly Grant[]> {
  const resource = `flow:${slug}`
  const result = await pool.query<{ principal: string; resource: string; scopes: string[] }>(
    `select principal, resource, scopes from grants
     where resource = $1 or left(resource, length($1) + 6) = $1 || '/step:'
     order by seq`,
    [resource]
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

/**
 * The delivery columns of one outbox row, saved across a rebuild (I3, SE-1).
 * The log is the audit; the status is operational state and is not derived
 * from it.
 */
type OutboxDelivery = {
  readonly id: string
  readonly status: string
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly lastError: string | null
  readonly sentAt: number | null
  readonly deliveredAt: number | null
}

/** Read the delivery state of every outbox row before a rebuild truncates it (I3). */
async function readOutboxDelivery(client: PoolClient): Promise<readonly OutboxDelivery[]> {
  const result = await client.query<{
    id: string
    status: string
    attempts: number
    next_attempt_at: string
    last_error: string | null
    sent_at: string | null
    delivered_at: string | null
  }>('select id, status, attempts, next_attempt_at, last_error, sent_at, delivered_at from outbox')
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error,
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
  }))
}

/**
 * Restore the delivery state that a rebuild saved (I3, SE-1). A row that was
 * `sending` when the rebuild started is a claim that no surviving worker
 * holds, so it returns to `queued`; a `sent` or `failed` row keeps its status,
 * attempt count, backoff and last error.
 */
async function restoreOutboxDelivery(
  client: PoolClient,
  delivery: readonly OutboxDelivery[]
): Promise<void> {
  for (const row of delivery) {
    await client.query(
      `update outbox
       set status = $2, attempts = $3, next_attempt_at = $4, last_error = $5,
           sent_at = $6, delivered_at = $7
       where id = $1`,
      [
        row.id,
        row.status === 'sending' ? 'queued' : row.status,
        row.attempts,
        row.nextAttemptAt,
        row.lastError,
        row.sentAt,
        row.deliveredAt,
      ]
    )
  }
}

/**
 * Update the projections that one event feeds. A type this slice does not read
 * projects nothing. Every event that carries an `outbox` entry projects one
 * outbox row in the same transaction (I2, I4).
 */
async function projectEvent(client: PoolClient, event: Event): Promise<void> {
  await projectOutbox(client, event)
  if (event.type === DEFINITION_CHANGED) {
    const change = readDefinitionChange(event)
    const draftVersion = await nextDraftVersion(client, change.flow)
    await client.query(
      `insert into flows (slug, draft, draft_hash, draft_version, updated_at, seq)
       values ($1, $2::jsonb, $3, $4, $5, $6)
       on conflict (slug) do update
         set draft = excluded.draft,
             draft_hash = excluded.draft_hash,
             draft_version = excluded.draft_version,
             updated_at = greatest(flows.updated_at, excluded.updated_at),
             seq = excluded.seq`,
      [
        change.flow,
        JSON.stringify(change.definition),
        contentHash(change.definition),
        draftVersion,
        event.at,
        event.seq,
      ]
    )
    return
  }
  if (event.type === DEFINITION_PUBLISHED) {
    const publication = readPublication(event)
    await client.query(
      `insert into flow_versions (slug, version, content_hash, definition, published_at, seq)
       values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (slug, version) do nothing`,
      [
        publication.slug,
        publication.version,
        publication.contentHash,
        JSON.stringify(publication.definition),
        event.at,
        event.seq,
      ]
    )
    const draftVersion = await nextDraftVersion(client, publication.slug)
    await client.query(
      `insert into flows (slug, draft_version, updated_at, seq)
       values ($1, $2, $3, $4)
       on conflict (slug) do update
         set draft_version = excluded.draft_version,
             updated_at = greatest(flows.updated_at, excluded.updated_at),
             seq = excluded.seq`,
      [publication.slug, draftVersion, event.at, event.seq]
    )
    return
  }
  if (event.type === FLOW_TITLE) {
    const change = readTitleChange(event)
    await client.query(
      `update flows
       set title = $2, updated_at = greatest(updated_at, $3), seq = $4
       where slug = $1`,
      [change.flow, change.title, event.at, event.seq]
    )
    return
  }
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
    return
  }
  if (event.type === INSTANCE_STARTED) {
    const start = readStart(event)
    await client.query(
      `insert into instances
         (id, flow_slug, definition_version, current_step, status, starter, values, version, holder, submitted, done, seq)
       values ($1, $2, $3, $4, 'waiting', $5, $6::jsonb, 0, null, false, false, $7)
       on conflict (id) do update
         set flow_slug = excluded.flow_slug,
             definition_version = excluded.definition_version,
             current_step = excluded.current_step,
             status = excluded.status,
             starter = excluded.starter,
             values = excluded.values,
             version = excluded.version,
             holder = excluded.holder,
             submitted = excluded.submitted,
             done = excluded.done,
             seq = excluded.seq`,
      [
        start.instanceId,
        start.flow,
        start.definitionVersion,
        start.currentStep,
        start.starter,
        JSON.stringify(start.values),
        event.seq,
      ]
    )
    if (start.currentStep !== undefined) {
      await upsertTask(client, {
        instanceId: start.instanceId,
        step: start.currentStep,
        assignees: start.assignees,
        holder: null,
        state: 'available',
        at: event.at,
        seq: event.seq,
      })
      // The start's active step schedules its timers from its own settings and
      // the time the task entered it (SE-3, SE-4, S12).
      const step = await stepOfInstance(client, start.instanceId, start.currentStep)
      if (step !== undefined) {
        const to = timerRecipient(start.assignees, start.currentStep)
        await scheduleStepTimers(client, {
          instanceId: start.instanceId,
          step,
          since: event.at,
          seq: event.seq,
          ...(to === undefined ? {} : { to }),
        })
      }
    }
    return
  }
  if (event.type === STEP_CLAIMED) {
    const claim = readClaim(event)
    await client.query(
      `update instances set holder = $2, status = 'in-progress', version = version + 1, seq = $3
       where id = $1`,
      [claim.instanceId, claim.holder, event.seq]
    )
    await client.query(
      `update tasks set holder = $3, state = 'opened', last_activity_at = $4, seq = $5
       where instance_id = $1 and step = $2`,
      [claim.instanceId, claim.step, claim.holder, event.at, event.seq]
    )
    return
  }
  if (event.type === STEP_COMPLETED) {
    const completion = readCompletion(event)
    const next = await nextStepOf(client, completion.instanceId, completion.step)
    await client.query(
      `update instances
       set current_step = $2, holder = null, done = $3, status = $4,
           version = version + 1, seq = $5
       where id = $1`,
      [
        completion.instanceId,
        next?.key ?? null,
        next === undefined,
        next === undefined ? 'done' : 'waiting',
        event.seq,
      ]
    )
    await client.query(
      `update tasks set state = 'completed', last_activity_at = $3, seq = $4
       where instance_id = $1 and step = $2`,
      [completion.instanceId, completion.step, event.at, event.seq]
    )
    // The completion closes the task, so its pending timers are cancelled in
    // the same event (SE-5, I2). A completion before the deadline therefore
    // sends no reminder and no escalation.
    await cancelStepTimers(client, {
      instanceId: completion.instanceId,
      step: completion.step,
      at: event.at,
      seq: event.seq,
    })
    if (next !== undefined) {
      const assignees = readAssignees(event.payload.assignees)
      await upsertTask(client, {
        instanceId: completion.instanceId,
        step: next.key,
        assignees,
        holder: null,
        state: 'available',
        at: event.at,
        seq: event.seq,
      })
      // The next step enters now, so its timers count from this event (SE-3).
      const to = timerRecipient(assignees, next.key)
      await scheduleStepTimers(client, {
        instanceId: completion.instanceId,
        step: next,
        since: event.at,
        seq: event.seq,
        ...(to === undefined ? {} : { to }),
      })
    }
    return
  }
  if (event.type === STEP_TAKEN_OVER) {
    const taken = readTakeover(event)
    // The holder moves to the actor who took the task over (AS-3, WF-5): the
    // instance and its task hold the new principal, the previous holder is
    // gone, and the version advances as the engine advanced it (I5). The
    // event keeps from, to, when and why on the log (I14, I4).
    await client.query(
      `update instances set holder = $2, status = 'in-progress', version = version + 1, seq = $3
       where id = $1`,
      [taken.instanceId, taken.to, event.seq]
    )
    await client.query(
      `update tasks set holder = $3, state = 'opened', last_activity_at = $4, seq = $5
       where instance_id = $1 and step = $2`,
      [taken.instanceId, taken.step, taken.to, event.at, event.seq]
    )
    return
  }
  if (event.type === INSTANCE_SUBMITTED) {
    const submitted = readSubmission(event)
    await client.query(
      `update instances set submitted = true, values = $2::jsonb, seq = $3 where id = $1`,
      [submitted.instanceId, JSON.stringify(submitted.values), event.seq]
    )
    return
  }
  if (event.type === STEP_SENT_BACK) {
    const sentBack = readSendBack(event)
    // The instance returns to the named step as the next revision (WF-3). The
    // holder is cleared, so the target step's people claim it again.
    await client.query(
      `update instances
       set current_step = $2,
           holder = null,
           done = false,
           status = 'waiting',
           version = version + 1,
           revisions = revisions || jsonb_build_object($2::text, $3::integer),
           seq = $4
       where id = $1`,
      [sentBack.instanceId, sentBack.to, sentBack.revision, event.seq]
    )
    // The step that sent the task back keeps its history: its task is no
    // longer open, so it leaves the inbox without deleting a row (I4).
    await client.query(
      `update tasks
       set holder = null, state = 'sent-back', last_activity_at = $3, seq = $4
       where instance_id = $1 and step = $2`,
      [sentBack.instanceId, sentBack.from, event.at, event.seq]
    )
    // The step that sent the task back is no longer open, so its pending
    // timers are cancelled in this event (SE-5, I2).
    await cancelStepTimers(client, {
      instanceId: sentBack.instanceId,
      step: sentBack.from,
      at: event.at,
      seq: event.seq,
    })
    // The target task is open again with the assignees the engine resolved for
    // that step (AS-4, I13). That is the row the inbox and the task read use.
    await upsertTask(client, {
      instanceId: sentBack.instanceId,
      step: sentBack.to,
      assignees: sentBack.assignees,
      holder: null,
      state: 'available',
      at: event.at,
      seq: event.seq,
    })
    // The target step's timers count from the send back that reopened it.
    const targetStep = await stepOfInstance(client, sentBack.instanceId, sentBack.to)
    if (targetStep !== undefined) {
      const to = timerRecipient(sentBack.assignees, sentBack.to)
      await scheduleStepTimers(client, {
        instanceId: sentBack.instanceId,
        step: targetStep,
        since: event.at,
        seq: event.seq,
        ...(to === undefined ? {} : { to }),
      })
    }
    return
  }
  if (event.type === INSTANCE_WITHDRAWN || event.type === INSTANCE_CANCELLED) {
    const close = readStepAndHolder(event)
    const kind = event.type === INSTANCE_WITHDRAWN ? 'withdrawn' : 'cancelled'
    // The close marker is derived state (WF-4, S13): the open task ends, the
    // previous step and holder stay for the undo, and the version advances as
    // the engine advanced it (I5). The close event itself stays on the log
    // (I4); the undo is a separate event that clears the marker.
    await client.query(
      `update instances
       set current_step = null,
           holder = null,
           done = false,
           status = $2,
           withdrawal = $2,
           previous_step = $3,
           previous_holder = $4,
           closed_at = $5,
           closed_by = $6,
           version = version + 1,
           seq = $7
       where id = $1`,
      [close.instanceId, kind, close.step, close.holder, event.at, event.actor ?? null, event.seq]
    )
    // The closed task leaves the open set; the inbox reads the instance's
    // open state too, so a closed instance is absent from every tab (VT-1).
    await client.query(
      `update tasks
       set holder = null, state = $3, last_activity_at = $4, seq = $5
       where instance_id = $1 and step = $2`,
      [close.instanceId, close.step, kind, event.at, event.seq]
    )
    // A close ends the open task, so its pending timers are cancelled in the
    // same event and neither a reminder nor the escalation follows (SE-5, I2).
    await cancelStepTimers(client, {
      instanceId: close.instanceId,
      step: close.step,
      at: event.at,
      seq: event.seq,
    })
    return
  }
  if (event.type === INSTANCE_UNDONE) {
    const restore = readStepAndHolder(event)
    // The undo restores the step and holder the close recorded and clears the
    // close marker (WF-5, I4). The close event stays on the log; this event is
    // the compensation that the task page reads back.
    await client.query(
      `update instances
       set current_step = $2,
           holder = $3,
           done = false,
           status = case when $3::text is null then 'waiting' else 'in-progress' end,
           withdrawal = null,
           previous_step = null,
           previous_holder = null,
           closed_at = null,
           closed_by = null,
           version = version + 1,
           seq = $4
       where id = $1`,
      [restore.instanceId, restore.step, restore.holder, event.seq]
    )
    await client.query(
      `update tasks
       set holder = $3,
           state = case when $3::text is null then 'available' else 'opened' end,
           last_activity_at = $4,
           seq = $5
       where instance_id = $1 and step = $2`,
      [restore.instanceId, restore.step, restore.holder, event.at, event.seq]
    )
    // The close cancelled the task's pending timers (SE-5), so the undo
    // schedules them again from the step's settings and the undo time (S13,
    // WF-5, SE-5). A cancelled row keeps its I3 key: a reminder is re-armed and
    // a new deadline occurrence inserts a new escalation, so a stale or
    // duplicate undo adds no second row (I3).
    const restoreStep = await stepOfInstance(client, restore.instanceId, restore.step)
    if (restoreStep !== undefined) {
      const assignees = await taskAssignees(client, restore.instanceId, restore.step)
      const to = restore.holder ?? timerRecipient(assignees, restore.step)
      await scheduleStepTimers(client, {
        instanceId: restore.instanceId,
        step: restoreStep,
        since: event.at,
        seq: event.seq,
        ...(to === undefined ? {} : { to }),
      })
    }
    return
  }
  if (event.type === TIMER_FIRED) {
    const fired = readTimerFired(event)
    // The timer fired at most once (I3): the claim and this mark share the one
    // transaction that appended the event.
    await client.query(
      `update timers set fired_at = $2, seq = $3 where id = $1 and fired_at is null`,
      [fired.timerId, event.at, event.seq]
    )
    // A step without a deadline keeps reminding: the next interval's reminder
    // is scheduled in the same event that records this one firing (SE-3).
    const [entry] = outboxOfEvent(event)
    if (fired.kind === 'reminder' && entry !== undefined) {
      const step = await stepOfInstance(client, fired.instanceId, fired.step)
      if (step !== undefined && step.deadlineMinutes === undefined) {
        const occurrence = Number(entry.payload.occurrence)
        const at = Number(entry.payload.at)
        const interval = (step.reminderMinutes ?? 0) * MINUTE_MS
        if (Number.isInteger(occurrence) && Number.isFinite(at) && interval > 0) {
          const to = typeof entry.payload.to === 'string' ? entry.payload.to : undefined
          await scheduleNextReminder(client, {
            instanceId: fired.instanceId,
            step,
            since: at - occurrence * interval,
            occurrence: occurrence + 1,
            seq: event.seq,
            ...(to === undefined ? {} : { to }),
          })
        }
      }
    }
    // The escalation adds its targets to the task and to the instance's
    // assignees (SE-4, I4). The occurrence is the event: a read folds the same
    // `adds` labels from the log, and this projection stores the same members
    // in the task row that the inbox reads (I2, I4).
    if (fired.kind === 'escalation') {
      const labels = escalationAddsOfEvent(event)
      if (labels.length > 0) {
        const membership = await teamMembershipAt(client, event.seq)
        const added = assigneesAddedBy(fired.step, labels, membership)
        const assignees = await taskAssignees(client, fired.instanceId, fired.step)
        const merged = mergeAssignees(assignees, added)
        await client.query(
          `update tasks set assignees = $3::jsonb, seq = $4
           where instance_id = $1 and step = $2`,
          [fired.instanceId, fired.step, JSON.stringify(merged), event.seq]
        )
      }
    }
    return
  }
  if (event.type === SEED_CLEARED_TYPE) {
    // The records are already marked cleared in the same transaction (DE-4).
    // Remove their projections again, so a live append and a rebuild agree.
    await deleteClearedSeedProjections(client)
  }
}

/**
 * Project the side effects that one event carries (I2, I4, SE-1). The row id is
 * deterministic from the event's client operation id and the entry's index, so
 * a rebuild and a replay insert the same ids and a duplicate insert is a no-op
 * (I1, I3). The instance and flow are stored beside the entry so the template
 * can build the link (SE-2).
 */
async function projectOutbox(client: PoolClient, event: Event): Promise<void> {
  const entries = outboxOfEvent(event)
  if (entries.length === 0) return
  const instanceId = await instanceIdOfEvent(client, event)
  // A start carries its flow on the event before the instance row exists; the
  // other side effects read the slug from the instance projection (I4, SE-2).
  const eventFlow = event.payload.flow
  const flowSlug =
    typeof eventFlow === 'string'
      ? eventFlow
      : instanceId === undefined
        ? null
        : await flowSlugOfInstance(client, instanceId)
  for (const [index, entry] of entries.entries()) {
    await client.query(
      `insert into outbox
         (id, effect, payload, created_at, delivered_at, seq, instance_id, flow_slug,
          status, attempts, next_attempt_at, last_error, sent_at)
       values ($1, $2, $3::jsonb, $4, null, $5, $6, $7, 'queued', 0, 0, null, null)
       on conflict (id) do nothing`,
      [
        outboxRowId(event.operationId, index),
        entry.operation,
        JSON.stringify(entry.payload),
        event.at,
        event.seq,
        instanceId ?? null,
        flowSlug,
      ]
    )
  }
}

/** The deterministic id of one outbox row (I3): the operation id and the entry index. */
function outboxRowId(operationId: string, index: number): string {
  return `${operationId}:${index}`
}

/**
 * The instance that an event's side effect belongs to (SE-2). A submit, a send
 * back, a close and a takeover name it on their payload; an `event.undone@1`
 * names the event it compensates, so its instance is that event's instance.
 */
async function instanceIdOfEvent(client: PoolClient, event: Event): Promise<string | undefined> {
  const direct = event.payload.instanceId ?? event.payload.instance
  if (typeof direct === 'string') return direct
  const undoOf = event.payload.eventId
  if (typeof undoOf !== 'number') return undefined
  const result = await client.query<{ instance_id: string | null }>(
    `select payload->>'instanceId' as instance_id from events where seq = $1`,
    [undoOf]
  )
  return result.rows[0]?.instance_id ?? undefined
}

/** The flow slug that an instance runs, from the instance projection (I4, SE-2). */
async function flowSlugOfInstance(client: PoolClient, instanceId: string): Promise<string | null> {
  const result = await client.query<{ flow_slug: string }>(
    'select flow_slug from instances where id = $1',
    [instanceId]
  )
  return result.rows[0]?.flow_slug ?? null
}

/** One resolved task row, folded from an instance event (I4, I13). */
type TaskRow = {
  readonly instanceId: string
  readonly step: string
  readonly assignees: readonly Assignee[]
  readonly holder: string | null
  readonly state: string
  readonly at: number
  readonly seq: number
}

/** Insert or replace one task row, so a rebuild reproduces the same projection (I4). */
async function upsertTask(client: PoolClient, task: TaskRow): Promise<void> {
  await client.query(
    `insert into tasks
       (id, instance_id, step, holder, state, assignees, last_activity_at, seq)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     on conflict (id) do update
       set holder = excluded.holder,
           state = excluded.state,
           assignees = excluded.assignees,
           last_activity_at = excluded.last_activity_at,
           seq = excluded.seq`,
    [
      taskId(task.instanceId, task.step),
      task.instanceId,
      task.step,
      task.holder,
      task.state,
      JSON.stringify(task.assignees),
      task.at,
      task.seq,
    ]
  )
}

/** The stable id of one step's task on one instance (I4). */
function taskId(instanceId: string, step: string): string {
  return `${instanceId}:${step}`
}

/** Map one `seed_records` row to its type. */
function seedRecordRow(row: {
  readonly profile: string
  readonly kind: SeedRecordKind
  readonly id: string
  readonly created_at: string
  readonly cleared_at: string | null
}): SeedRecord {
  return {
    profile: row.profile,
    kind: row.kind,
    id: row.id,
    createdAt: Number(row.created_at),
    clearedAt: row.cleared_at === null ? null : Number(row.cleared_at),
  }
}

/**
 * Delete every projection that a cleared seed record created (DE-4, I4). The
 * function is idempotent: a missing row is already gone. A user record has no
 * local projection except the principal cache; its Keycloak user is deleted by
 * the caller because the directory is not in this database.
 */
async function deleteClearedSeedProjections(client: PoolClient): Promise<void> {
  const result = await client.query<{ kind: SeedRecordKind; id: string }>(
    'select kind, id from seed_records where cleared_at is not null order by created_at, kind, id'
  )
  for (const record of result.rows) {
    if (record.kind === 'user') {
      await client.query('delete from principals where id = $1', [record.id])
      continue
    }
    if (record.kind === 'team') {
      await client.query('delete from team_members where team_slug = $1', [record.id])
      await client.query('delete from teams where slug = $1', [record.id])
      continue
    }
    if (record.kind === 'group') {
      // A directory group has no local projection; the caller deletes it from
      // Keycloak, as it deletes a user (DE-4, ID-6).
      continue
    }
    if (record.kind === 'flow') {
      await client.query('delete from flow_versions where slug = $1', [record.id])
      await client.query('delete from flows where slug = $1', [record.id])
      continue
    }
    if (record.kind === 'instance') {
      await client.query('delete from tasks where instance_id = $1', [record.id])
      await client.query('delete from timers where instance_id = $1', [record.id])
      await client.query('delete from instances where id = $1', [record.id])
      continue
    }
    const grant = readSeedGrantId(record.id)
    if (grant !== undefined) {
      await client.query(
        'delete from grants where principal = $1 and resource = $2 and scopes = $3::text[]',
        [grant.principal, grant.resource, grant.scopes]
      )
    }
  }
}

/** Read the grant key that a seed record holds, or undefined when it is malformed. */
function readSeedGrantId(
  id: string
):
  | { readonly principal: string; readonly resource: string; readonly scopes: readonly string[] }
  | undefined {
  try {
    const value = JSON.parse(id) as unknown
    if (!Array.isArray(value) || value.length !== 3) return undefined
    const [principal, resource, scopes] = value
    if (typeof principal !== 'string' || typeof resource !== 'string') return undefined
    if (!isStringArray(scopes)) return undefined
    return { principal, resource, scopes }
  } catch {
    return undefined
  }
}

/** The step that follows one key in the definition that the instance pins (WF-1, DF-2). */
async function nextStepOf(
  client: PoolClient,
  instanceId: string,
  step: string
): Promise<FlowStep | undefined> {
  const result = await client.query<{ definition: unknown }>(
    `select v.definition
     from instances i
     join flow_versions v on v.content_hash = i.definition_version
     where i.id = $1`,
    [instanceId]
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  return nextStep(readStoredDefinition(row.definition, `instance ${instanceId}`), step)
}

/** One step of the definition that the instance pins, or undefined when it has none (DF-2, S12). */
async function stepOfInstance(
  client: PoolClient,
  instanceId: string,
  step: string
): Promise<FlowStep | undefined> {
  const result = await client.query<{ definition: unknown }>(
    `select v.definition
     from instances i
     join flow_versions v on v.content_hash = i.definition_version
     where i.id = $1`,
    [instanceId]
  )
  const row = result.rows[0]
  if (row === undefined) return undefined
  return readStoredDefinition(row.definition, `instance ${instanceId}`).steps.find(
    (candidate) => candidate.key === step
  )
}

/**
 * The team membership that a task sees at one point on the log (AS-4, SE-4):
 * the `config.team.changed@1` events up to the firing, folded by the engine's
 * own team projection. A rebuild replays the same prefix, so the added members
 * of an escalation do not depend on a second store (I4, I6).
 */
async function teamMembershipAt(
  client: PoolClient,
  seq: number
): Promise<ReturnType<typeof teamMembership>> {
  const result = await client.query<{
    seq: string
    operation_id: string
    type: string
    at: string
    actor: string | null
    payload: Record<string, unknown>
  }>(
    `select seq, operation_id, type, at, actor, payload from events
     where type = $1 and seq <= $2 order by seq`,
    [TEAM_CHANGE_TYPE, seq]
  )
  return teamMembership(
    result.rows.map((row) => ({
      seq: Number(row.seq),
      operationId: row.operation_id,
      type: row.type,
      at: Number(row.at),
      actor: row.actor ?? undefined,
      payload: row.payload,
    }))
  )
}

/** The resolved assignees that a task row holds, or none when the row is absent (SE-4, I4). */
async function taskAssignees(
  client: PoolClient,
  instanceId: string,
  step: string
): Promise<readonly Assignee[]> {
  const result = await client.query<{ assignees: readonly Assignee[] }>(
    'select assignees from tasks where instance_id = $1 and step = $2',
    [instanceId, step]
  )
  return result.rows[0]?.assignees ?? []
}

/** Read the start payload that the projection folds (I4, I13, #222). */
function readStart(event: Event): {
  instanceId: string
  flow: string
  definitionVersion: string
  currentStep: string
  assignees: readonly Assignee[]
  starter: string | null
  values: Record<string, unknown>
} {
  const { instanceId, flow, definitionVersion, currentStep, starter } = event.payload
  if (
    typeof instanceId !== 'string' ||
    typeof flow !== 'string' ||
    typeof definitionVersion !== 'string' ||
    typeof currentStep !== 'string'
  ) {
    throw new Error(`events: malformed ${INSTANCE_STARTED} payload at seq ${event.seq}`)
  }
  return {
    instanceId,
    flow,
    definitionVersion,
    currentStep,
    assignees: readAssignees(event.payload.assignees),
    starter: typeof starter === 'string' ? starter : null,
    values: readJsonRecord(event.payload.values),
  }
}

/** Read a claim payload that the projection folds (I4). */
function readClaim(event: Event): { instanceId: string; step: string; holder: string } {
  const { instanceId, step, holder } = event.payload
  if (typeof instanceId !== 'string' || typeof step !== 'string' || typeof holder !== 'string') {
    throw new Error(`events: malformed ${STEP_CLAIMED} payload at seq ${event.seq}`)
  }
  return { instanceId, step, holder }
}

/** Read a completion payload that the projection folds (I4). */
function readCompletion(event: Event): { instanceId: string; step: string } {
  const { instanceId, step } = event.payload
  if (typeof instanceId !== 'string' || typeof step !== 'string') {
    throw new Error(`events: malformed ${STEP_COMPLETED} payload at seq ${event.seq}`)
  }
  return { instanceId, step }
}

/** Read a `timer.fired@1` payload that the projection folds (SE-3, SE-4, I3). */
function readTimerFired(event: Event): {
  timerId: string
  instanceId: string
  step: string
  kind: 'reminder' | 'escalation'
} {
  const { timerId, instanceId, step, kind } = event.payload
  if (
    typeof timerId !== 'string' ||
    typeof instanceId !== 'string' ||
    typeof step !== 'string' ||
    (kind !== 'reminder' && kind !== 'escalation')
  ) {
    throw new Error(`events: malformed ${TIMER_FIRED} payload at seq ${event.seq}`)
  }
  return { timerId, instanceId, step, kind }
}

/** Read a submit payload that the projection folds (I4, FM-7). */
function readSubmission(event: Event): { instanceId: string; values: Record<string, unknown> } {
  const { instanceId } = event.payload
  if (typeof instanceId !== 'string') {
    throw new Error(`events: malformed ${INSTANCE_SUBMITTED} payload at seq ${event.seq}`)
  }
  return { instanceId, values: readJsonRecord(event.payload.values) }
}

/** Read a takeover payload that the projection folds (AS-3, S10, I4, I14). */
function readTakeover(event: Event): {
  instanceId: string
  step: string
  from: string
  to: string
  when: number
  why: string
} {
  const { instanceId, step, from, to, when, why } = event.payload
  if (
    typeof instanceId !== 'string' ||
    typeof step !== 'string' ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof when !== 'number' ||
    typeof why !== 'string'
  ) {
    throw new Error(`events: malformed ${STEP_TAKEN_OVER} payload at seq ${event.seq}`)
  }
  return { instanceId, step, from, to, when, why }
}

/** Read a send-back payload that the projection folds (WF-3, I4). */
function readSendBack(event: Event): {
  instanceId: string
  from: string
  to: string
  revision: number
  assignees: readonly Assignee[]
} {
  const { instanceId, from, to, revision } = event.payload
  if (
    typeof instanceId !== 'string' ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof revision !== 'number'
  ) {
    throw new Error(`events: malformed ${STEP_SENT_BACK} payload at seq ${event.seq}`)
  }
  return {
    instanceId,
    from,
    to,
    revision,
    assignees: readAssignees(event.payload.assignees),
  }
}

/** Read the step and holder that a close records and an undo restores (WF-4, WF-5, I4). */
function readStepAndHolder(event: Event): {
  instanceId: string
  step: string
  holder: string | null
} {
  const { instanceId, step, holder } = event.payload
  if (typeof instanceId !== 'string' || typeof step !== 'string') {
    throw new Error(`events: malformed ${event.type} payload at seq ${event.seq}`)
  }
  return { instanceId, step, holder: typeof holder === 'string' ? holder : null }
}

/** Read the assignees that an event records (I13); an absent or malformed list is empty. */
function readAssignees(value: unknown): readonly Assignee[] {
  return Array.isArray(value) ? (value as readonly Assignee[]) : []
}

/** Read a JSON object payload; an absent or malformed value is an empty record. */
function readJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Read one grant from a `config.grant.changed@1` event. */
function readGrant(event: Event): Grant {
  const { principal, scopes, resource } = event.payload
  if (typeof principal !== 'string' || typeof resource !== 'string' || !isStringArray(scopes)) {
    throw new Error(`events: malformed ${GRANT_CHANGE_TYPE} payload at seq ${event.seq}`)
  }
  return { principal, scopes, resource }
}

/** Read one definition change from a `config.definition.changed@1` event (#220). */
function readDefinitionChange(event: Event): { flow: string; definition: FlowDefinition } {
  const { flow, definition } = event.payload
  if (typeof flow !== 'string' || !isRecord(definition)) {
    throw new Error(`events: malformed ${DEFINITION_CHANGED} payload at seq ${event.seq}`)
  }
  return { flow, definition: readStoredDefinition(definition, `event at seq ${event.seq}`) }
}

/** Read one publication from a `config.definition.published@1` event (DF-2). */
function readPublication(event: Event): {
  slug: string
  version: number
  contentHash: string
  definition: FlowDefinition
} {
  const { slug, version, contentHash: hash, definition } = event.payload
  if (
    typeof slug !== 'string' ||
    typeof version !== 'number' ||
    typeof hash !== 'string' ||
    !isRecord(definition)
  ) {
    throw new Error(`events: malformed ${DEFINITION_PUBLISHED} payload at seq ${event.seq}`)
  }
  return {
    slug,
    version,
    contentHash: hash,
    definition: readStoredDefinition(definition, `event at seq ${event.seq}`),
  }
}

/** Read one title change from a `config.flow.title@1` event (#220). */
function readTitleChange(event: Event): { flow: string; title: string } {
  const { flow, title } = event.payload
  if (typeof flow !== 'string' || typeof title !== 'string') {
    throw new Error(`events: malformed ${FLOW_TITLE} payload at seq ${event.seq}`)
  }
  return { flow, title }
}

/** Parse one stored definition through the engine, or name the row that is malformed. */
function readStoredDefinition(value: unknown, label: string): FlowDefinition {
  try {
    return parse(JSON.stringify(value))
  } catch (error) {
    throw new Error(`db: malformed definition in ${label}: ${messageOf(error)}`)
  }
}

/** The version that the current draft would publish as (#220, DF-2). */
async function nextDraftVersion(client: PoolClient, slug: string): Promise<number> {
  const result = await client.query<{ next: number }>(
    'select coalesce(max(version), 0) + 1 as next from flow_versions where slug = $1',
    [slug]
  )
  return Number(result.rows[0].next)
}

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
