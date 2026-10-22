// Issue #216, DE-2, DE-3, ADR 0011, ADR 0013: the worker process. It polls the
// outbox and the timer table of the one PostgreSQL database and never decides
// correctness on its own (A9). This slice delivers no side effect, so a pending
// row stays pending: the sink arrives with 0.3.0 (SE-1). The loop idles when the
// tables are empty.

import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import type { Config } from './config.js'
import { createPool } from './db.js'

/** The idle poll interval of the worker, in milliseconds. */
const POLL_INTERVAL_MS = 1000

/** A running worker loop and the way to drain it. */
export type Worker = { readonly stop: () => Promise<void> }

/** Start the outbox and timer loop for one configuration. */
export function startWorker(config: Config): Worker {
  const pool = createPool(config.databaseUrl)
  let stopped = false
  const loop = run(pool, () => stopped)
  return {
    stop: async () => {
      stopped = true
      await loop
      await pool.end()
    },
  }
}

/** Poll until `stopped`, reporting pending work without claiming it. */
async function run(pool: Pool, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    try {
      const pending = await pendingCount(pool)
      if (pending > 0) {
        process.stderr.write(
          `enform worker: ${pending} side effect(s) are pending; the sink arrives with 0.3.0\n`
        )
      }
    } catch (error) {
      process.stderr.write(`enform worker: ${messageOf(error)}\n`)
    }
    await delay(POLL_INTERVAL_MS)
  }
}

/** The number of side effects that are due: undelivered outbox rows and due timers. */
async function pendingCount(pool: Pool): Promise<number> {
  const outbox = await pool.query<{ count: number }>(
    'select count(*)::int as count from outbox where delivered_at is null'
  )
  const timers = await pool.query<{ count: number }>(
    'select count(*)::int as count from timers where cancelled_at is null and fire_at <= $1',
    [Date.now()]
  )
  return (outbox.rows[0]?.count ?? 0) + (timers.rows[0]?.count ?? 0)
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
