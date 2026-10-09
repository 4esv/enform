// Issue #39, S02, AC-1, AC-2, AC-4, I8, I14, MVP.md 5.6: grants as derived state.
//
// Scaffold. The versioned event type is in place. `addGrant` and `grantsOf`
// arrive with the implementation; the grant check in
// `stories/S02-grant-scopes/scenario.test.ts` is marked expected to fail until
// then (CONTRIBUTING.md: a failing test before the implementation).

import type { Grant } from './authorize.js'
import { configType } from './config.js'
import type { ActorId, Log, Operation, OperationDeps } from './operation.js'

/** The versioned event type of one grant change (AC-2, I14). */
export const GRANT_CHANGE_TYPE = configType('grant')

/**
 * Record one grant as an attributed configuration operation (AC-2, I14). The
 * implementation arrives with issue #39.
 */
export function addGrant(_grant: Grant, _actor: ActorId, _deps: OperationDeps): Operation {
  throw new Error('grants: addGrant is not implemented yet (issue #39)')
}

/**
 * The grants that the log records, in log order (I4). The implementation
 * arrives with issue #39.
 */
export function grantsOf(_log: Log): readonly Grant[] {
  throw new Error('grants: grantsOf is not implemented yet (issue #39)')
}
