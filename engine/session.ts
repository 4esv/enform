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

/** The marker that a sealed value carries, so a ciphertext is never read as a plaintext (I11). */
export const SEALED = 'enc.v1'

/** The session before any draft, and after sign-out or the idle timeout (I11): no key, no drafts. */
export const emptySession: Session = { key: undefined, drafts: [] }

/** The plaintext of one draft (I11): the serialized edit that the cipher hides. */
export function plaintextOf(draft: Draft): string {
  return JSON.stringify(draft.edit)
}

/** Whether a value is a sealed ciphertext (I11): it carries the cipher marker. */
export function isSealed(ciphertext: string): boolean {
  return ciphertext.startsWith(`${SEALED}.`)
}

/**
 * The default cipher (I11, ADR 0007): a deterministic, reversible, keyed
 * encoding that stands in for AES-256-GCM. It mixes the plaintext with a
 * keystream derived from the key and hex-encodes the result behind a marker,
 * so the output is never the plaintext, and `open` reverses `seal` under the
 * same key.
 */
export const streamCipher: Cipher = {
  seal: (plaintext, key) => {
    const stream = keystream(key, plaintext.length)
    let body = ''
    for (let i = 0; i < plaintext.length; i += 1) {
      body += ((plaintext.charCodeAt(i) ^ stream[i]) & 0xffff).toString(16).padStart(4, '0')
    }
    return `${SEALED}.${body}`
  },
  open: (ciphertext, key) => {
    if (!isSealed(ciphertext)) {
      throw new Error('session: the value is not a sealed ciphertext (I11)')
    }
    const body = ciphertext.slice(SEALED.length + 1)
    const stream = keystream(key, body.length / 4)
    let plaintext = ''
    for (let i = 0; i < body.length; i += 4) {
      plaintext += String.fromCharCode(
        (Number.parseInt(body.slice(i, i + 4), 16) ^ stream[i / 4]) & 0xffff
      )
    }
    return plaintext
  },
}

/**
 * Open a session with a key (I11): the key that the session controls, before
 * any draft.
 */
export function openSession(key: SessionKey): Session {
  return { key, drafts: [] }
}

/**
 * Seal one draft under the session key (I11): the plaintext edit becomes a
 * ciphertext, the only form in which an edit enters the stored session.
 */
export function encryptDraft(
  draft: Draft,
  key: SessionKey,
  cipher: Cipher = streamCipher
): EncryptedDraft {
  return { id: draft.id, ciphertext: cipher.seal(plaintextOf(draft), key) }
}

/**
 * Recover the plaintext of one draft from its ciphertext under the session key
 * (I11): the inverse of `encryptDraft`. After sign-out or the idle timeout the
 * key is gone, so there is nothing to recover with.
 */
export function decryptDraft(
  encrypted: EncryptedDraft,
  key: SessionKey,
  cipher: Cipher = streamCipher
): string {
  return cipher.open(encrypted.ciphertext, key)
}

/**
 * Save one edit into the session as ciphertext (I11, RT-3): the session seals
 * the draft under its key and stores only the ciphertext, replacing any
 * earlier draft under the same id. A session with no key (signed out or idle)
 * stores nothing.
 */
export function saveEncryptedDraft(
  session: Session,
  draft: Draft,
  cipher: Cipher = streamCipher
): Session {
  if (session.key === undefined) return session
  const encrypted = encryptDraft(draft, session.key, cipher)
  return {
    key: session.key,
    drafts: [...session.drafts.filter((entry) => entry.id !== draft.id), encrypted],
  }
}

/**
 * Sign out (I11): the session destroys the key and every ciphertext, so the
 * drafts become unrecoverable and the session is empty.
 */
export function signOut(session: Session): Session {
  return session.key === undefined && session.drafts.length === 0 ? session : emptySession
}

/**
 * The idle timeout (I11): the session destroys the key and every ciphertext,
 * so the drafts become unrecoverable and the session is empty.
 */
export function idleTimeout(session: Session): Session {
  return session.key === undefined && session.drafts.length === 0 ? session : emptySession
}

/**
 * The keystream of one key (I11): a deterministic sequence derived from the key
 * id, the stand-in for the key schedule and counter of AES-256-GCM.
 */
function keystream(key: SessionKey, length: number): number[] {
  const stream: number[] = []
  for (let i = 0; i < length; i += 1) {
    stream.push((key.id.charCodeAt(i % key.id.length) + i * 31) & 0xffff)
  }
  return stream
}
