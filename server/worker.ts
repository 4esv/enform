// Issue #240, SE-1, SE-2, I2, I3, ADR 0003, ADR 0011: the worker delivers the
// outbox. The engine records a state change and its side effects in one event
// (I2); `projectEvent` projects each side effect into one `outbox` row with a
// deterministic id (I4, I3). This process claims the due rows, sends them
// through the configured SMTP transport, and records delivery or a retry. It
// never decides correctness: PostgreSQL is the only queue (ADR 0003).
//
// Issue #248, S12, SE-3, SE-4, SE-5: a pass also fires the due timers before it
// claims the outbox. The engine decides the timer and its side effect; the
// worker only claims the row, appends the `timer.fired@1` event and delivers
// the reminder or the escalation that the same transaction put in the outbox.
//
// A missing SMTP URL leaves the rows queued and logs once (SE-1): a small
// installation runs without a mail server. A row reaches `sent` at most once
// (I3): a claimed row is `sending`, a delivered row is `sent`, and a second
// pass finds no due row. A failed send records the attempt count, the last
// error and an exponential backoff, and stops after the maximum attempt count.

import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import type { Config } from './config.js'
import { createPool, fireDueTimers } from './db.js'
import { listDirectoryGroups } from './keycloak.js'
import { createMailer, type MailEntry, type Mailer } from './mail.js'

/** The idle poll interval of the worker, in milliseconds. */
const POLL_INTERVAL_MS = 1000

/** How many due rows one claim takes. */
const BATCH_SIZE = 20

/** How many times one side effect is attempted before it stops. */
const MAX_ATTEMPTS = 5

/** The first retry delay, doubled after each failed attempt. */
const BACKOFF_BASE_MS = 1000

/** The longest retry delay. */
const BACKOFF_MAX_MS = 60_000

/** One claimed outbox row, as the worker sends it. */
type OutboxRow = MailEntry & {
  readonly attempts: number
}

/** A running worker loop and the way to drain it. */
export type Worker = { readonly stop: () => Promise<void> }

/** How long the worker keeps one group snapshot between timer passes (SE-4, I6). */
const GROUP_CACHE_MS = 30_000

/** Start the outbox loop for one configuration (ADR 0011, SE-1). */
export function startWorker(config: Config): Worker {
  const pool = createPool(config.databaseUrl)
  const mailer = createMailer(config)
  let stopped = false
  let groups:
    | { readonly at: number; readonly members: ReadonlyMap<string, readonly string[]> }
    | undefined
  const groupMembers = async (): Promise<ReadonlyMap<string, readonly string[]>> => {
    if (groups !== undefined && groups.at + GROUP_CACHE_MS > Date.now()) return groups.members
    try {
      const listed = await listDirectoryGroups(config)
      const members = new Map(listed.map((group) => [group.id, group.members.map((m) => m.id)]))
      groups = { at: Date.now(), members }
      return members
    } catch {
      // A directory read failure records the labels without group members for
      // this pass; the next pass reads again. A reminder never depends on it.
      return groups?.members ?? new Map()
    }
  }
  const loop = run(pool, mailer, groupMembers, () => stopped)
  return {
    stop: async () => {
      stopped = true
      await loop
      mailer?.close()
      await pool.end()
    },
  }
}

/** Claim and deliver the due outbox rows until `stopped` (SE-1, I3). */
async function run(
  pool: Pool,
  mailer: Mailer | undefined,
  groupMembers: () => Promise<ReadonlyMap<string, readonly string[]>>,
  stopped: () => boolean
): Promise<void> {
  // A worker that starts finds no live claim: a row left in `sending` by a
  // crashed worker is due again. No other process is delivering it (ADR 0003).
  await resetStaleClaims(pool)
  let reported = false
  while (!stopped()) {
    try {
      // A due timer fires into the outbox before the batch is claimed, so the
      // reminder or escalation of this pass goes out in the same pass (SE-3,
      // SE-4, I2, I3). An escalation resolves its group targets through the
      // directory and records the members on the event (I4, I13).
      await fireDueTimers(pool, Date.now(), 20, await groupMembers())
    } catch (error) {
      process.stderr.write(`enform worker: ${messageOf(error)}\n`)
      await delay(POLL_INTERVAL_MS)
      continue
    }
    if (mailer === undefined) {
      if (!reported) {
        const queued = await queuedCount(pool)
        process.stderr.write(
          `enform worker: SMTP is not configured; ${queued} side effect(s) stay queued\n`
        )
        reported = true
      }
      await delay(POLL_INTERVAL_MS)
      continue
    }
    try {
      const batch = await claimDue(pool, Date.now())
      // A SIGTERM drains the batch that is already claimed and then stops.
      for (const row of batch) await deliver(pool, mailer, row)
      if (batch.length === 0) await delay(POLL_INTERVAL_MS)
    } catch (error) {
      process.stderr.write(`enform worker: ${messageOf(error)}\n`)
      await delay(POLL_INTERVAL_MS)
    }
  }
}

/** Reset the claims of a crashed worker, so their rows are due again (SE-1). */
async function resetStaleClaims(pool: Pool): Promise<void> {
  await pool.query("update outbox set status = 'queued' where status = 'sending'")
}

/**
 * Claim up to `BATCH_SIZE` due rows with `for update skip locked` and mark them
 * `sending` in one transaction (SE-1, I3). A second worker skips a claimed row
 * instead of sending it twice.
 */
async function claimDue(pool: Pool, now: number): Promise<readonly OutboxRow[]> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const selected = await client.query<{
      id: string
      effect: string
      payload: Record<string, unknown>
      instance_id: string | null
      flow_slug: string | null
      recipient: string | null
      attempts: number
    }>(
      `select o.id, o.effect, o.payload, o.instance_id, o.flow_slug, o.attempts,
              p.email as recipient
       from outbox o
       left join principals p on p.id = o.payload->>'to'
       where o.status in ('queued', 'failed')
         and o.attempts < $1
         and o.next_attempt_at <= $2
       order by o.created_at, o.seq, o.id
       limit $3
       for update of o skip locked`,
      [MAX_ATTEMPTS, now, BATCH_SIZE]
    )
    if (selected.rows.length === 0) {
      await client.query('commit')
      return []
    }
    const ids = selected.rows.map((row) => row.id)
    await client.query("update outbox set status = 'sending' where id = any($1::text[])", [ids])
    await client.query('commit')
    return selected.rows.map((row) => ({
      id: row.id,
      effect: row.effect,
      payload: row.payload,
      ...(row.recipient === null ? {} : { recipient: row.recipient }),
      attempts: row.attempts,
      ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
      ...(row.flow_slug === null ? {} : { flowSlug: row.flow_slug }),
    }))
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Send one claimed row and record the result (SE-1, I3). */
async function deliver(pool: Pool, mailer: Mailer, row: OutboxRow): Promise<void> {
  if (row.recipient === undefined) {
    await markFailed(pool, row, 'the recipient has no email address in the directory', Date.now())
    process.stderr.write(
      `enform worker: ${row.effect} ${row.id} failed: the recipient has no email address\n`
    )
    return
  }
  try {
    await mailer.send(row)
    await markSent(pool, row.id, Date.now())
    process.stderr.write(`enform worker: sent ${row.effect} ${row.id}\n`)
  } catch (error) {
    const message = messageOf(error)
    await markFailed(pool, row, message, Date.now())
    process.stderr.write(`enform worker: ${row.effect} ${row.id} failed: ${message}\n`)
  }
}

/** Mark one row delivered. A retry of an already-sent row changes nothing (I3). */
async function markSent(pool: Pool, id: string, at: number): Promise<void> {
  await pool.query(
    `update outbox
     set status = 'sent', sent_at = $2, delivered_at = $2, attempts = attempts + 1, last_error = null
     where id = $1 and status = 'sending'`,
    [id, at]
  )
}

/**
 * Record one failed attempt (SE-1): the attempt count, the last error and the
 * next time the row is due. The fifth failed attempt stops the row with the
 * last error; the row keeps the status `failed`.
 */
async function markFailed(pool: Pool, row: OutboxRow, error: string, at: number): Promise<void> {
  const attempts = row.attempts + 1
  await pool.query(
    `update outbox
     set status = 'failed', attempts = $2, next_attempt_at = $3, last_error = $4
     where id = $1 and status = 'sending'`,
    [row.id, attempts, at + backoff(attempts), error]
  )
}

/** The exponential backoff after one failed attempt (SE-1). */
function backoff(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS)
}

/** The rows that a worker with no SMTP configuration leaves queued (SE-1). */
async function queuedCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `select count(*)::int as count from outbox
     where status in ('queued', 'failed') and attempts < $1`,
    [MAX_ATTEMPTS]
  )
  return result.rows[0]?.count ?? 0
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
