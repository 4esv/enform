// Issue #214, I1, ADR 0004: the server boundary mints the IDs that the engine
// does not receive from a client. An operation ID is a UUIDv7, so the log keeps
// one time-ordered global sequence. `crypto.randomUUID` makes a version 4 UUID,
// which ADR 0004 forbids for an operation ID.

import { randomBytes } from 'node:crypto'
import { uuidv7 } from '../engine/id.js'

/** A UUIDv7 for a server-created operation (ADR 0004). */
export function newOperationId(at: number = Date.now()): string {
  return uuidv7(at, (length) => new Uint8Array(randomBytes(length)))
}

/** A random identifier for operational state, such as a session row (ADR 0012). */
export function newStateId(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex')
}

/** A random CSRF token for one session (ADR 0012). */
export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}
