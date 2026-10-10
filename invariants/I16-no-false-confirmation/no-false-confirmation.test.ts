// Issue #22, I16, A4: the no false confirmation oracle.
//
// I16: the interface never shows an unconfirmed state as confirmed. An
// optimistic update is applied to the local state immediately and shown as
// `pending` until the server acknowledges it; only then does it become
// `confirmed`. The oracle below states that as a check over one update log: no
// pending update appears in the confirmed set that the interface shows. It
// takes any end state, so a story run can call it after its own run (MVP.md
// 11.4).

import { expect, test } from 'vitest'
import {
  acknowledge,
  applyOptimistic,
  confirmedOnly,
  emptyUpdates,
  type UpdateLog,
} from '../../engine/updates.js'

/** One optimistic edit: the payload that the interface applies (I16). */
const EDIT: Readonly<Record<string, unknown>> = { field: 'title', value: 'Quarterly report' }

/** A second optimistic edit, so a log holds more than one update (I16). */
const OTHER_EDIT: Readonly<Record<string, unknown>> = { field: 'amount', value: 250 }

/**
 * The I16 oracle. Check one update log against the confirmed set that the
 * interface shows: every update in that set was acknowledged by the server, so
 * a pending update never appears confirmed, and every update shows whether it
 * is pending or confirmed. It takes any end state, so a story run can call it
 * after its own run (MVP.md 11.4). `confirmed` is injectable, so a check
 * states I16 as a mutation: a projection that leaks a pending update into the
 * confirmed set must fail the oracle.
 */
function assertNoFalseConfirmation(
  updates: UpdateLog,
  confirmed: (updates: UpdateLog) => UpdateLog = confirmedOnly
): void {
  const acknowledged = new Set(
    updates.filter((update) => update.state === 'confirmed').map((update) => update.id)
  )
  for (const update of updates) {
    expect(
      update.state === 'pending' || update.state === 'confirmed',
      `update ${update.id} does not show whether it is pending or confirmed (I16)`
    ).toBe(true)
  }
  for (const update of confirmed(updates)) {
    expect(
      acknowledged.has(update.id),
      `the interface shows update ${update.id} as confirmed while the server has not acknowledged it (I16)`
    ).toBe(true)
  }
}

test.fails('#22 an optimistic update shows as pending until the server acknowledges it (I16)', () => {
  const applying = applyOptimistic(emptyUpdates, 'update-1', EDIT)
  expect(applying).toEqual([{ id: 'update-1', edit: EDIT, state: 'pending' }])
  expect(confirmedOnly(applying)).toEqual([])
  assertNoFalseConfirmation(applying)

  const both = applyOptimistic(applying, 'update-2', OTHER_EDIT)
  expect(both.filter((update) => update.state === 'pending').map((update) => update.id)).toEqual([
    'update-1',
    'update-2',
  ])
  expect(confirmedOnly(both)).toEqual([])
  assertNoFalseConfirmation(both)

  const acknowledged = acknowledge(both, 'update-1')
  expect(acknowledged.find((update) => update.id === 'update-1')?.state).toBe('confirmed')
  expect(acknowledged.find((update) => update.id === 'update-2')?.state).toBe('pending')
  expect(confirmedOnly(acknowledged).map((update) => update.id)).toEqual(['update-1'])
  assertNoFalseConfirmation(acknowledged)
})

/**
 * The deliberate violation of I16: a confirmed projection that leaks a pending
 * update, so the interface shows an unconfirmed state as confirmed. The oracle
 * must fail on it, and `test.fails` asserts that failure (I16).
 */
test.fails('#22 the oracle fails when a pending update leaks into the confirmed set (I16)', () => {
  const updates: UpdateLog = [{ id: 'update-1', edit: EDIT, state: 'pending' }]
  const leaks = (all: UpdateLog): UpdateLog => all
  assertNoFalseConfirmation(updates, leaks)
})
