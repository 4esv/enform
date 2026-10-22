// Issue #218, ID-1, ID-5, ADR 0012, I8: encrypt the browser refresh token at
// rest. The session row keeps the Keycloak refresh token so logout can end the
// identity provider session, but a plaintext token in PostgreSQL is a bearer
// credential at rest. AES-256-GCM with a per-installation 32-byte key keeps the
// token confidential and authenticated. The stored form is
// `iv.tag.ciphertext`, each part in base64. The key comes from the
// configuration and only the logout path decrypts.

import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** The authenticated cipher of the session refresh token (ADR 0012). */
const ALGORITHM = 'aes-256-gcm'

/** The nonce length of AES-256-GCM, in bytes. */
const IV_BYTES = 12

/** The key length that the configuration must carry, in bytes. */
export const ENCRYPTION_KEY_BYTES = 32

/**
 * A fresh 32-byte key in base64, for `enform init` when the configuration has
 * none. The key is random per installation, so two installations never share
 * one.
 */
export function newEncryptionKey(): string {
  return randomBytes(ENCRYPTION_KEY_BYTES).toString('base64')
}

/**
 * Whether a configuration value is a 32-byte key in base64. `enform doctor`
 * checks it, and the session code treats an invalid key as absent.
 */
export function validEncryptionKey(value: string): boolean {
  if (value === '') return false
  return Buffer.from(value, 'base64').length === ENCRYPTION_KEY_BYTES
}

/**
 * Encrypt one refresh token. The result is `iv.tag.ciphertext`, each part in
 * base64, so the row carries no plaintext and a tampered value fails to
 * decrypt.
 */
export function encryptToken(key: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyBytes(key), iv, { authTagLength: 16 })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ciphertext].map((part) => part.toString('base64')).join('.')
}

/**
 * Decrypt one refresh token. A wrong key, a tampered value and a malformed
 * value all throw; the logout path catches the error and ends only the local
 * session, because the identity provider session cannot be reached without the
 * token.
 */
export function decryptToken(key: string, stored: string): string {
  const [iv, tag, ciphertext] = stored.split('.')
  if (iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error('session: the encrypted refresh token is malformed')
  }
  const decipher = createDecipheriv(ALGORITHM, keyBytes(key), Buffer.from(iv, 'base64'), {
    authTagLength: 16,
  })
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** The key bytes, or a named error when the configuration value is not a key. */
function keyBytes(key: string): Buffer {
  const bytes = Buffer.from(key, 'base64')
  if (bytes.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `session: the encryption key must be ${ENCRYPTION_KEY_BYTES} bytes in base64 (ADR 0012)`
    )
  }
  return bytes
}
