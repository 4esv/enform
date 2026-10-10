// Issue #73, ID-5, ID-4, A1, A8, AS-4, I4, I6, I14: group membership
// synchronization and deprovisioning.
//
// ID-5: group membership synchronizes at sign-in and on a schedule, and when
// a user is deprovisioned their claimed tasks go back to the pool. The
// triggers, sign-in (ID-1, OIDC) and a schedule, are not part of this engine;
// the synchronization is a pure function of an injected directory (I6), so the
// same directory always gives the same enform membership. AS-4 makes a group
// and a team resolve live through that membership, so a member who joined is
// included with no new publication. A deprovision is an engine change: it
// releases every task that the deprovisioned user holds, so the task returns
// to the pool (A1), and it records one attributed event on the append-only log
// (I4, I14). Both functions are pure and deterministic (I6): they read no
// clock, no random source and no I/O of their own.
//
// The synchronization and the deprovision are not read yet: the synced
// membership holds nobody and a deprovision releases no task. The check in
// tools/membership.test.ts is marked as expected to fail until they land
// (#73, ID-5).

import type { Instance } from './instance.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'
import type { Membership } from './resolve.js'

/** The versioned event type of a deprovision (ID-5, I14). */
export const USER_DEPROVISIONED = 'user.deprovisioned@1'

/**
 * The result of a deprovision (ID-5, I4). `accepted` says whether the engine
 * released the tasks that the deprovisioned user held. When it did not, the
 * instances are unchanged, `operation` is absent, and `reason` says why: the
 * directory still holds the principal, so the account is not deprovisioned.
 */
export type DeprovisionResult = {
  readonly accepted: boolean
  /** The instances after the release: a task that the principal held returns to the pool (A1). */
  readonly instances: readonly Instance[]
  /** The operation that records the deprovision (I14); absent when the engine refused. */
  readonly operation?: Operation
  /** Why the engine refused the deprovision (ID-5); absent when it accepted. */
  readonly reason?: string
}

/**
 * Issue #73 (ID-5): the synchronization is not read yet, so the enform
 * membership holds nobody and a member who joined stays absent.
 */
export function syncMembership(_directory: Membership, _current: Membership): Membership {
  return () => []
}

/**
 * Issue #73 (ID-5): the deprovision is not read yet, so no claimed task is
 * released and the log records nothing.
 */
export function deprovision(
  _principal: ActorId,
  _membership: Membership,
  instances: readonly Instance[],
  _deps: OperationDeps
): DeprovisionResult {
  return { accepted: true, instances }
}
