// Issue #73, #267, ID-5, ID-4, A1, A8, AS-4, I4, I6, I8, I14, WF-5: group
// membership synchronization and deprovisioning.
//
// ID-5: group membership synchronizes at sign-in and on a schedule, and when
// a user is deprovisioned their claimed tasks go back to the pool. The
// triggers, sign-in (ID-1, OIDC) and a schedule, are not part of this engine;
// the synchronization is a pure function of an injected directory (I6), so the
// same directory always gives the same enform membership. AS-4 makes a group
// and a team resolve live through that membership, so a member who joined is
// included with no new publication. A deprovision is an engine change: it
// releases every task that the deprovisioned user holds through the same
// `task.released@1` event a flow owner's release records, with the reason, so
// the task returns to the pool (A1), the timeline says why and the release is
// undoable like any manual action (WF-5); one attributed `user.deprovisioned@1`
// event records the account (I4, I14). The directory itself deprovisions, or a
// person with `org.grants` (I8). The log then names the deprovisioned
// (`deprovisionedOf`), so the shared resolver routes a target that names one
// of them to nobody (I10). Every function is pure and deterministic (I6):
// they read no clock, no random source and no I/O of their own.

import { authorize, type Grant } from './authorize.js'
import type { Instance } from './instance.js'
import {
  type ActorId,
  createOperation,
  type Log,
  type Operation,
  type OperationDeps,
} from './operation.js'
import type { Membership } from './resolve.js'
import { TASK_RELEASED } from './undo.js'

/** The versioned event type of a deprovision (ID-5, I14). */
export const USER_DEPROVISIONED = 'user.deprovisioned@1'

/** The versioned event type of a provision (ID-5, I14): the directory holds the person again. */
export const USER_PROVISIONED = 'user.provisioned@1'

/** The actor of a change the directory synchronization makes on its own (ID-5, I14). */
export const DIRECTORY_ACTOR = 'system:directory'

/** Who deprovisions (ID-5, I8): the directory itself, or a person with `org.grants`. */
export type DeprovisionOptions = {
  /** The acting principal; absent means the directory synchronization. */
  readonly actor?: ActorId
  /** The grants that apply to the actor (AC-1, I8). */
  readonly grants?: readonly Grant[]
}

/**
 * The principals the log says are deprovisioned (ID-5, I4): named by a
 * `user.deprovisioned@1` event and not by a later `user.provisioned@1`.
 */
export function deprovisionedOf(log: Log): ReadonlySet<ActorId> {
  const gone = new Set<ActorId>()
  for (const event of log) {
    const principal = event.payload.principal
    if (typeof principal !== 'string') continue
    if (event.type === USER_DEPROVISIONED) gone.add(principal)
    else if (event.type === USER_PROVISIONED) gone.delete(principal)
  }
  return gone
}

/** The reason a deprovision records on each release it makes (WF-5, VT-5). */
export function deprovisionReason(principal: ActorId): string {
  return `${principal} was deprovisioned`
}

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
  /** One `task.released@1` per task the principal held, with the reason (WF-5, I14); empty when refused. */
  readonly releases: readonly Operation[]
  /** Why the engine refused the deprovision (ID-5); absent when it accepted. */
  readonly reason?: string
}

/**
 * Synchronize the enform membership with the directory (ID-5, ID-4, I6). The
 * sync makes the membership equal to the directory: every principal resolves
 * to the members that the directory holds now, so a member who joined is
 * present and a member who left is absent. A principal that the directory no
 * longer holds, a deprovisioned user, resolves to nobody. The canonical enform
 * membership is a pure function of the directory (I6), so `current`, the
 * membership that the sync replaces, never narrows the result, and two syncs
 * of the same directory agree.
 */
export function syncMembership(directory: Membership, current: Membership): Membership {
  // The directory is the single source of the synced membership (I6); the
  // current membership names what the sync replaces and is not read.
  void current
  return (principal) => directory(principal)
}

/**
 * Deprovision one user and release the tasks that they hold (ID-5, I4, I8,
 * I14, WF-5). The engine accepts the deprovision only when the synchronized
 * membership no longer holds the principal, so a directory that still lists
 * the account cannot release its tasks, and only from the directory itself
 * (no actor) or from a person with `org.grants` on `org`. On acceptance every
 * instance whose current task the principal holds has its holder cleared, so
 * the task returns to the pool (A1); each release is one `task.released@1`
 * with the reason, attributed to the actor, so the timeline says why and a
 * flow owner may undo it like any manual release (WF-5); and one attributed
 * `user.deprovisioned@1` records the principal and the released tasks (I4,
 * I14). The instance keeps the released task's assignees, so the members that
 * the directory holds now can claim it (AS-4). The function is pure and
 * deterministic (I6): the ids come from `deps`, one per operation.
 */
export function deprovision(
  principal: ActorId,
  membership: Membership,
  instances: readonly Instance[],
  deps: OperationDeps,
  options: DeprovisionOptions = {}
): DeprovisionResult {
  const actor = options.actor ?? DIRECTORY_ACTOR
  if (actor !== DIRECTORY_ACTOR && !authorize(options.grants ?? [], 'org.grants', 'org')) {
    return {
      accepted: false,
      instances,
      releases: [],
      reason: `${actor} needs org.grants on org to deprovision ${principal} (I8)`,
    }
  }
  if (membership(principal).length > 0) {
    return {
      accepted: false,
      instances,
      releases: [],
      reason: `${principal} is still a current member, so the account is not deprovisioned (ID-5)`,
    }
  }
  const next: Instance[] = []
  const releases: Operation[] = []
  const released: { readonly instanceId: string; readonly step: string }[] = []
  for (const instance of instances) {
    const step = instance.currentStep
    if (instance.holder !== principal || step === undefined) {
      next.push(instance)
      continue
    }
    next.push({ ...instance, holder: undefined, version: (instance.version ?? 0) + 1 })
    // An instance the log projects carries its id, and its release is one
    // event of that instance (I4); an instance without one is only answered.
    if (instance.instanceId === undefined) continue
    released.push({ instanceId: instance.instanceId, step })
    releases.push(
      createOperation(
        TASK_RELEASED,
        {
          instanceId: instance.instanceId,
          step,
          holder: principal,
          reason: deprovisionReason(principal),
        },
        deps,
        actor
      )
    )
  }
  const operation = createOperation(USER_DEPROVISIONED, { principal, released }, deps, actor)
  return { accepted: true, instances: next, operation, releases }
}
