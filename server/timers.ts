// Issue #248, S12, SE-3, SE-4, SE-5, I2, I3, I4, DE-4, ADR 0003: the durable
// timers of a task. The engine decides the reminder occurrences, the escalation
// and the I3 keys (reminders.ts); this module writes the rows that the worker
// later claims, in the same transaction as the event that entered or closed the
// step (I2). The row id is the side effect's I3 key, so a rebuild re-creates the
// same row from the same event and a replay inserts nothing (I3, I4).
//
// Scheduling is not a decision of its own: the caller passes the step of the
// instance's pinned definition and the time the task entered it, and
// `timersOfStep` answers the entries. Cancelling marks the pending rows of one
// task; a fired row keeps its `fired_at` and is never cancelled (SE-5).

import type { PoolClient } from 'pg'
import type { FlowStep } from '../engine/definition.js'
import type { Assignee } from '../engine/instance.js'
import { nextReminderTimer, type ScheduledTimer, timersOfStep } from '../engine/reminders.js'
import { sideEffectKey } from '../engine/sideEffects.js'

/** The time the task entered the step, with the step and the instance it belongs to (SE-3, SE-4). */
export type StepTimerSchedule = {
  readonly instanceId: string
  readonly step: FlowStep
  /** The time the task entered the step, from the server clock (I6). */
  readonly since: number
  /** The event that entered the step, for the projection's order (I4). */
  readonly seq: number
  /** The person a timer notifies; absent when the step resolved to nobody. */
  readonly to?: string
}

/**
 * The principal that a task's timer notifies (S12): the first member of the
 * step's resolved assignees, or undefined when the step resolved to nobody.
 */
export function timerRecipient(assignees: readonly Assignee[], step: string): string | undefined {
  return assignees.find((assignee) => assignee.step === step)?.members[0]
}

/**
 * Schedule the timers that one step sets, in the event that entered the step
 * (SE-3, SE-4, I2). A step with no timer settings inserts nothing. A duplicate
 * insert of the same I3 key is a no-op, so a replay or a rebuild is idempotent
 * (I3).
 */
export async function scheduleStepTimers(
  client: PoolClient,
  schedule: StepTimerSchedule
): Promise<number> {
  const timers = timersOfStep(schedule.step, {
    instance: schedule.instanceId,
    since: schedule.since,
    ...(schedule.to === undefined ? {} : { to: schedule.to }),
  })
  for (const timer of timers) {
    await insertTimer(client, schedule.instanceId, schedule.step.key, timer, schedule.seq)
  }
  return timers.length
}

/**
 * Schedule the next reminder of a step that has no deadline (SE-3, S12). The
 * worker calls it in the same transaction that records the previous reminder
 * firing, so a task that waits keeps reminding until it completes or is closed.
 * A step with a deadline or no interval schedules nothing (SE-4).
 */
export async function scheduleNextReminder(
  client: PoolClient,
  input: {
    readonly instanceId: string
    readonly step: FlowStep
    readonly since: number
    readonly occurrence: number
    readonly seq: number
    readonly to?: string
  }
): Promise<boolean> {
  const timer = nextReminderTimer(
    input.step,
    {
      instance: input.instanceId,
      since: input.since,
      ...(input.to === undefined ? {} : { to: input.to }),
    },
    input.occurrence
  )
  if (timer === undefined) return false
  await insertTimer(client, input.instanceId, input.step.key, timer, input.seq)
  return true
}

/**
 * Cancel the pending timers of one task in the event that closed it (SE-5,
 * I2). The reminder and escalation rows of the instance and step that have not
 * fired carry `cancelled_at`; a fired row keeps its `fired_at`, so a
 * cancellation never rewrites what already happened (I3, I4).
 */
export async function cancelStepTimers(
  client: PoolClient,
  input: {
    readonly instanceId: string
    readonly step: string
    readonly at: number
    readonly seq: number
  }
): Promise<number> {
  const result = await client.query(
    `update timers
     set cancelled_at = $3, seq = $4
     where instance_id = $1 and step = $2 and cancelled_at is null and fired_at is null`,
    [input.instanceId, input.step, input.at, input.seq]
  )
  return result.rowCount ?? 0
}

/** Insert one timer, keyed by its side effect's I3 key (I3). A duplicate is a no-op. */
async function insertTimer(
  client: PoolClient,
  instanceId: string,
  step: string,
  timer: ScheduledTimer,
  seq: number
): Promise<void> {
  const to = timer.entry.payload.to
  await client.query(
    `insert into timers
       (id, kind, fire_at, cancelled_at, fired_at, instance_id, step, recipient, payload, seq)
     values ($1, $2, $3, null, null, $4, $5, $6, $7::jsonb, $8)
     on conflict (id) do nothing`,
    [
      sideEffectKey(timer.entry),
      timer.kind,
      timer.fireAt,
      instanceId,
      step,
      typeof to === 'string' ? to : null,
      JSON.stringify(timer.entry.payload),
      seq,
    ]
  )
}
