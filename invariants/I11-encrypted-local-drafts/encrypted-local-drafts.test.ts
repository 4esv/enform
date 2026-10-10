// Issue #17, I11, A7, ADR 0007: the encrypted local drafts oracle.
//
// I11: drafts in the browser are encrypted with a key that the session
// controls. Sign-out or idle timeout deletes them. The oracle below states
// that as a check over one session: every stored draft is ciphertext under the
// session key and none is plaintext, and a session that sign-out or the idle
// timeout destroyed holds no key and no ciphertext, so the drafts are
// unrecoverable. It takes any end state, so a story run can call it after its
// own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import type { Draft } from '../../engine/drafts.js'
import {
  decryptDraft,
  emptySession,
  idleTimeout,
  isSealed,
  openSession,
  plaintextOf,
  type Session,
  type SessionKey,
  saveEncryptedDraft,
  signOut,
} from '../../engine/session.js'

/** The session key (I11): in the browser it lives in sessionStorage (ADR 0007). */
const KEY: SessionKey = { id: 'session-key-1' }

/** One draft: the edit that the session seals under its key (RT-3). */
const DRAFT: Draft = {
  id: 'draft-1',
  edit: { field: 'title', value: 'Quarterly report' },
  state: 'saved',
}

/** A second draft, so a session holds more than one (I11). */
const OTHER_DRAFT: Draft = { id: 'draft-2', edit: { field: 'amount', value: 250 }, state: 'saved' }

/**
 * The I11 oracle. Check one session: every stored draft is ciphertext under
 * the session key, and the plaintext of a draft never appears in the stored
 * form, so an unencrypted local copy is visible; and a destroyed session
 * (`destroyed`) holds no key and no ciphertext, so sign-out and the idle
 * timeout make the drafts unrecoverable. It takes any end state, so a story
 * run can call it after its own run (MVP.md 11.4).
 */
function assertEncryptedLocalDrafts(session: Session, destroyed = false): void {
  for (const stored of session.drafts) {
    expect(
      isSealed(stored.ciphertext),
      `draft ${stored.id} is stored without encryption (I11)`
    ).toBe(true)
    const key = session.key
    expect(key, `draft ${stored.id} is stored without a session key (I11)`).toBeDefined()
    if (key === undefined) continue
    const plaintext = decryptDraft(stored, key)
    expect(stored.ciphertext, `draft ${stored.id} stores its plaintext (I11)`).not.toBe(plaintext)
    expect(
      stored.ciphertext.includes(plaintext),
      `draft ${stored.id} stores its plaintext (I11)`
    ).toBe(false)
  }
  if (destroyed) {
    expect(
      session.key,
      'the session key survived sign-out or the idle timeout (I11)'
    ).toBeUndefined()
    expect(
      session.drafts,
      'the encrypted drafts survived sign-out or the idle timeout (I11)'
    ).toEqual([])
  }
}

test('#17 a stored draft is ciphertext, and sign-out or idle destroys it (I11)', () => {
  const live = saveEncryptedDraft(saveEncryptedDraft(openSession(KEY), DRAFT), OTHER_DRAFT)
  expect(live.key).toEqual(KEY)
  expect(live.drafts.map((stored) => stored.id)).toEqual(['draft-1', 'draft-2'])
  expect(live.drafts[0].ciphertext).not.toBe(plaintextOf(DRAFT))
  assertEncryptedLocalDrafts(live)

  // The key recovers the plaintext, so the stored form is the sealed edit and
  // the round trip is exact.
  expect(decryptDraft(live.drafts[0], KEY)).toBe(plaintextOf(DRAFT))
  expect(decryptDraft(live.drafts[1], KEY)).toBe(plaintextOf(OTHER_DRAFT))

  const signedOut = signOut(live)
  expect(signedOut).toEqual(emptySession)
  assertEncryptedLocalDrafts(signedOut, true)

  const idled = idleTimeout(live)
  expect(idled).toEqual(emptySession)
  assertEncryptedLocalDrafts(idled, true)
})

/**
 * The deliberate violation of I11: a session that stores a draft's plaintext
 * instead of a ciphertext, so the local copy is not encrypted. The oracle must
 * fail on it, and `test.fails` asserts that failure (I11).
 */
test.fails('#17 the oracle fails on a draft that is stored in plaintext (I11)', () => {
  const plaintext: Session = {
    key: KEY,
    drafts: [{ id: DRAFT.id, ciphertext: plaintextOf(DRAFT) }],
  }
  assertEncryptedLocalDrafts(plaintext)
})

/**
 * The deliberate violation of I11: a key that survives sign-out, so the drafts
 * stay recoverable after the session ends. The oracle must fail on it, and
 * `test.fails` asserts that failure (I11).
 */
test.fails('#17 the oracle fails on a key that survives sign-out (I11)', () => {
  const kept: Session = { key: KEY, drafts: [] }
  assertEncryptedLocalDrafts(kept, true)
})
