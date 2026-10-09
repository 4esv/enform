// Issue #7, I1, I4, I6, ADR 0004: the idempotent operation model.

import type { Event, Log, Operation, OperationId } from './operation.js'

/**
 * Derived state (I4). It is rebuilt from the log, and it holds the operation
 * IDs that already produced it, so that a retry is a no-op (I1).
 */
export type State = {
  readonly applied: ReadonlySet<OperationId>
  readonly log: Log
}

/** The state before any operation. */
export const emptyState: State = { applied: new Set(), log: [] }

/**
 * Apply one operation and append its event to the log. Pure and deterministic
 * (I6): it reads no clock and no random source. Applying the same operation
 * again returns the same state (I1): its ID is already in `applied`.
 */
export function apply(operation: Operation, state: State): State {
  if (state.applied.has(operation.id)) return state
  const event: Event = {
    seq: state.log.length + 1,
    operationId: operation.id,
    type: operation.type,
    at: operation.at,
    payload: operation.payload,
  }
  return {
    applied: new Set([...state.applied, operation.id]),
    log: [...state.log, event],
  }
}
