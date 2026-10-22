import { expect, test } from 'vitest'
import {
  decryptToken,
  ENCRYPTION_KEY_BYTES,
  encryptToken,
  newEncryptionKey,
  validEncryptionKey,
} from './crypto.js'

// Issue #218, ID-1, ID-5, ADR 0012: the session refresh token is encrypted at
// rest. The cipher round-trips a token with its installation key, a wrong key
// fails the GCM authentication instead of returning plaintext, and the stored
// form carries no plaintext.

test('#218 a refresh token round-trips through AES-256-GCM (ADR 0012)', () => {
  const key = newEncryptionKey()
  const token = 'refresh-token-with-+/= characters'
  const stored = encryptToken(key, token)

  expect(validEncryptionKey(key), 'a generated key is 32 bytes in base64').toBe(true)
  expect(stored, 'the stored form is iv.tag.ciphertext').toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
  expect(stored, 'the stored value carries no plaintext token').not.toContain(token)
  expect(decryptToken(key, stored), 'the token round-trips').toBe(token)
})

test('#218 a wrong key and a malformed value fail to decrypt (ADR 0012)', () => {
  const key = newEncryptionKey()
  const stored = encryptToken(key, 'refresh-token')

  expect(() => decryptToken(newEncryptionKey(), stored), 'a wrong key fails the tag').toThrow()
  expect(() => decryptToken(key, 'not-a-ciphertext'), 'a malformed value fails').toThrow()
  const [iv, , ciphertext] = stored.split('.')
  const tampered = [iv, Buffer.alloc(16).toString('base64'), ciphertext].join('.')
  expect(() => decryptToken(key, tampered), 'a tampered tag fails').toThrow()
})

test('#218 a configuration key is valid only when it decodes to 32 bytes (ADR 0012)', () => {
  expect(validEncryptionKey('')).toBe(false)
  expect(validEncryptionKey(Buffer.alloc(ENCRYPTION_KEY_BYTES - 1).toString('base64'))).toBe(false)
  expect(validEncryptionKey(Buffer.alloc(ENCRYPTION_KEY_BYTES).toString('base64'))).toBe(true)
})
