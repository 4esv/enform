// Issue #39, S02, AC-1, AC-2, AC-4, I8, I14, MVP.md 5.6: grants as derived state.
//
// The log is the single source of truth (I4), so the grant set is a projection
// of it, like the outbox (outbox.ts). A grant change is one attributed
// `config.grant.changed@1` operation (AC-2, I14), and `grantsOf` reads the log
// back into the grants that `authorize` evaluates (AC-1). Grants are
// append-only, so the projection changes no event.

import type { Grant } from './authorize.js'
import { configOperation, configType } from './config.js'
import type { ActorId, Log, Operation, OperationDeps } from './operation.js'

/** The versioned event type of one grant change (AC-2, I14). */
export const GRANT_CHANGE_TYPE = configType('grant')

/**
 * Record one grant as an attributed configuration operation (AC-2, I14). The
 * payload is the grant itself (MVP.md 5.6): the principal, its scopes and its
 * resource. `configOperation` gives the operation the `grant` kind and the
 * actor, so the change is attributed on the log (I14).
 */
export function addGrant(grant: Grant, actor: ActorId, deps: OperationDeps): Operation {
  return configOperation(
    {
      kind: 'grant',
      actor,
      payload: { principal: grant.principal, scopes: grant.scopes, resource: grant.resource },
    },
    deps
  )
}

/**
 * The grants that the log records, in log order (I4, AC-1). The log is the
 * single source of truth, so the grant set is a projection of it and never a
 * second store: a rebuild from the log reproduces the grants (I4). Grants are
 * append-only, so the projection keeps every grant change and drops none.
 */
export function grantsOf(log: Log): readonly Grant[] {
  return log
    .filter((event) => event.type === GRANT_CHANGE_TYPE)
    .map((event) => readGrant(event.payload))
}

/** Read one grant from a `config.grant.changed@1` payload. A malformed payload throws. */
function readGrant(payload: Readonly<Record<string, unknown>>): Grant {
  const { principal, scopes, resource } = payload
  if (typeof principal !== 'string') {
    throw new Error('grants: the principal must be a string')
  }
  if (!isStringArray(scopes)) {
    throw new Error('grants: the scopes must be an array of strings')
  }
  if (typeof resource !== 'string') {
    throw new Error('grants: the resource must be a string')
  }
  return { principal, scopes, resource }
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}
