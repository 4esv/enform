// Issue #21, I15, A4, A7, ADR 0007: the no acknowledged edit lost oracle.
//
// I15: if the interface shows "Saved on this device", the edit gets to the
// server, or it stays recoverable on the device until a deliberate deletion.
// The interface always shows the difference between "Saved on this device" and
// "Synced". The oracle below states that as a check over one draft session: a
// saved edit is synced or recoverable, and a held draft always shows its
// state. It takes any end state, so a story run can call it after its own run
// (MVP.md 11.4).

import { expect, test } from 'vitest'
import {
  type Draft,
  type DraftSession,
  discardDraft,
  emptySession,
  recoverable,
  saveDraft,
  syncDraft,
} from '../../engine/drafts.js'

/** One edit: the payload that the device holds for a draft (RT-3). */
const EDIT: Readonly<Record<string, unknown>> = { field: 'title', value: 'Quarterly report' }

/** A second edit, so a session holds more than one draft (I15). */
const OTHER_EDIT: Readonly<Record<string, unknown>> = { field: 'amount', value: 250 }

/**
 * The I15 oracle. Check one draft session: every edit that the device saved is
 * either synced on the server or still recoverable on the device, so a saved
 * edit is released only by a deliberate discard; and every held draft shows
 * its state, so the interface shows the difference between "Saved on this
 * device" and "Synced". It takes any end state, so a story run can call it
 * after its own run (MVP.md 11.4).
 */
function assertNoAcknowledgedEditLost(session: DraftSession): void {
  for (const saved of session.saved) {
    const held = session.held.find((draft) => draft.id === saved.id)
    const released = session.discarded.includes(saved.id)
    expect(
      held !== undefined || released,
      `the saved edit on draft ${saved.id} disappeared without a sync or a deliberate discard (I15)`
    ).toBe(true)
  }
  for (const draft of session.held) {
    expect(
      draft.state === 'saved' || draft.state === 'synced',
      `draft ${draft.id} does not show whether it is saved or synced (I15)`
    ).toBe(true)
    if (draft.state === 'saved') {
      expect(
        Object.keys(draft.edit).length > 0,
        `the saved edit on draft ${draft.id} is not recoverable (I15)`
      ).toBe(true)
    }
  }
}

test.fails('#21 a saved edit is synced or recoverable until a deliberate discard (I15)', () => {
  const draft1: Draft = { id: 'draft-1', edit: EDIT, state: 'saved' }
  const saved = saveDraft(saveDraft(emptySession, draft1.id, draft1.edit), 'draft-2', OTHER_EDIT)
  expect(saved.saved).toEqual([draft1, { id: 'draft-2', edit: OTHER_EDIT, state: 'saved' }])
  expect(recoverable(saved.held).map((draft) => draft.id)).toEqual(['draft-1', 'draft-2'])
  assertNoAcknowledgedEditLost(saved)

  const synced = syncDraft(saved, draft1.id)
  expect(synced.held.find((draft) => draft.id === draft1.id)?.state).toBe('synced')
  expect(recoverable(synced.held).map((draft) => draft.id)).toEqual(['draft-2'])
  assertNoAcknowledgedEditLost(synced)

  const discarded = discardDraft(synced, 'draft-2')
  expect(discarded.held.map((draft) => draft.id)).toEqual(['draft-1'])
  expect(discarded.discarded).toEqual(['draft-2'])
  expect(recoverable(discarded.held)).toEqual([])
  assertNoAcknowledgedEditLost(discarded)
})

/**
 * The deliberate violation of I15: a save that drops the edit, with no sync
 * and no discard, so the saved edit is not synced and not recoverable. The
 * oracle must fail on it, and `test.fails` asserts that failure.
 */
test.fails('#21 the oracle fails on a save that drops the edit (I15)', () => {
  const dropped: DraftSession = {
    saved: [{ id: 'draft-1', edit: EDIT, state: 'saved' }],
    held: [],
    discarded: [],
  }
  assertNoAcknowledgedEditLost(dropped)
})
