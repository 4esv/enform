// Issue #17, I11, A7, ADR 0007: the encrypted local draft session.
//
// I11: drafts in the browser are encrypted with a key that the session
// controls. Sign-out or idle timeout deletes them. A session holds a
// session-scoped key and the drafts as ciphertext. The key seals each edit
// into a ciphertext, and the stored session keeps only the ciphertext, so the
// plaintext never appears in it. Sign-out and the idle timeout destroy the key
// and the ciphertext together, so the drafts become unrecoverable. ADR 0007
// uses AES-256-GCM with the key in sessionStorage and the ciphertext in
// IndexedDB; real crypto is browser-native and out of scope here, so the
// cipher is an injected, deterministic, reversible encoding. This model is
// pure and deterministic (I6): it reads no clock, no random source and no I/O
// of its own.
//
// The model is a scaffold: the types and the surface below are fixed, and the
// behavior arrives in the next commit, when the suite stops expecting the first
// check to fail (#17).

import type { Draft } from './drafts.js'

/**
 * The session-scoped key that seals the drafts (I11). In the browser it lives
 * in sessionStorage (ADR 0007), which clears when the session ends.
 */
export type SessionKey = {
  readonly id: string
}

/**
 * One encrypted draft: the stored form of an edit. The session holds the
 * ciphertext under the session key, never the plaintext (I11).
 */
export type EncryptedDraft = {
  readonly id: string
  readonly ciphertext: string
}

/**
 * The session that controls the key and holds the encrypted drafts (I11). A
 * live session has a key and its ciphertext. A session after sign-out or the
 * idle timeout has neither: the key and the ciphertext are destroyed together,
 * so the drafts are unrecoverable.
 */
export type Session = {
  readonly key: SessionKey | undefined
  readonly drafts: readonly EncryptedDraft[]
}

/**
 * A symmetric cipher (I11): `seal` hides a plaintext under a key, and `open`
 * recovers it under the same key. ADR 0007 uses AES-256-GCM; the model only
 * needs a deterministic, reversible, keyed transform.
 */
export type Cipher = {
  readonly seal: (plaintext: string, key: SessionKey) => string
  readonly open: (ciphertext: string, key: SessionKey) => string
}

/** The session before any draft, and after sign-out or the idle timeout (I11): no key, no drafts. */
export const emptySession: Session = { key: undefined, drafts: [] }

/** The plaintext of one draft (I11): the serialized edit that the cipher hides. */
export function plaintextOf(draft: Draft): string {
  return JSON.stringify(draft.edit)
}

/**
 * Open a session with a key (I11): the key that the session controls, before
 * any draft.
 */
export function openSession(key: SessionKey): Session {
  return { key, drafts: [] }
}

/** Whether a value is a sealed ciphertext (I11). Not implemented yet (#17). */
export function isSealed(_ciphertext: string): boolean {
  throw new Error('session: isSealed is not implemented yet (I11, #17)')
}

/**
 * Seal one draft under the session key (I11): the plaintext edit becomes a
 * ciphertext, the only form in which an edit enters the stored session. Not
 * implemented yet (#17).
 */
export function encryptDraft(_draft: Draft, _key: SessionKey, _cipher?: Cipher): EncryptedDraft {
  throw new Error('session: encryptDraft is not implemented yet (I11, #17)')
}

/**
 * Recover the plaintext of one draft from its ciphertext under the session key
 * (I11): the inverse of `encryptDraft`. Not implemented yet (#17).
 */
export function decryptDraft(
  _encrypted: EncryptedDraft,
  _key: SessionKey,
  _cipher?: Cipher
): string {
  throw new Error('session: decryptDraft is not implemented yet (I11, #17)')
}

/**
 * Save one edit into the session as ciphertext (I11, RT-3): the session seals
 * the draft under its key and stores only the ciphertext, replacing any
 * earlier draft under the same id. Not implemented yet (#17).
 */
export function saveEncryptedDraft(_session: Session, _draft: Draft, _cipher?: Cipher): Session {
  throw new Error('session: saveEncryptedDraft is not implemented yet (I11, #17)')
}

/**
 * Sign out (I11): the session destroys the key and every ciphertext, so the
 * drafts become unrecoverable and the session is empty. Not implemented yet
 * (#17).
 */
export function signOut(_session: Session): Session {
  throw new Error('session: signOut is not implemented yet (I11, #17)')
}

/**
 * The idle timeout (I11): the session destroys the key and every ciphertext,
 * so the drafts become unrecoverable and the session is empty. Not implemented
 * yet (#17).
 */
export function idleTimeout(_session: Session): Session {
  throw new Error('session: idleTimeout is not implemented yet (I11, #17)')
}
