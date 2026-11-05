// Issue #267, ID-5, ID-4, AS-1, A1, I4, I8, I14, WF-5: the directory
// synchronization and the deprovision of the release server.
//
// ID-5: group membership synchronizes at sign-in and on a schedule, and when
// a user is deprovisioned their claimed tasks go back to the pool, recorded on
// the log. Sign-in records the person's profile and groups as
// `identity.principal.updated@1` (server/http.ts); the scheduled pass below
// visits every known account and records the same change for the ones that
// moved, deprovisions the accounts the directory disabled or deleted, and
// provisions the ones it holds again. The engine decides every change
// (engine/membership.ts): what a deprovision releases, who may make it, and
// what the log then says. This module only reads the directory and the store
// and appends what the engine decided, in one transaction per account (I2).
//
// The directory seam of the shared resolver (server/intents.ts) is built here
// too: the deprovisioned accounts come from the log, and the manager of a
// person comes from the directory's `manager` attribute (AS-1).

import type { Pool } from 'pg'
import type { Grant } from '../engine/authorize.js'
import { instanceOf, type ProjectedInstance } from '../engine/instances.js'
import {
  DIRECTORY_ACTOR,
  deprovision,
  deprovisionedOf,
  USER_PROVISIONED,
} from '../engine/membership.js'
import { type ActorId, createOperation, type Log, type OperationDeps } from '../engine/operation.js'
import type { Config } from './config.js'
import {
  appendOperation,
  appendOperations,
  instancesHeldBy,
  listPrincipals,
  readLog,
  upsertPrincipal,
} from './db.js'
import { newOperationId } from './ids.js'
import type { ResolverDirectory } from './intents.js'
import { directoryUser, listDirectoryGroups } from './keycloak.js'

/** What a deprovision released (ID-5, A1). */
export type DeprovisionOutcome = {
  readonly principal: ActorId
  readonly released: readonly { readonly instanceId: string; readonly step: string }[]
  /** True when the log already named the account deprovisioned, so nothing was appended (I1). */
  readonly alreadyDeprovisioned?: boolean
}

/** Who deprovisions through the API (I8): the acting principal and the grants that apply to it. */
export type DeprovisionActor = {
  readonly actor: ActorId
  readonly grants: readonly Grant[]
}

/** The engine's refusal of a deprovision (I8, ID-5). */
export class DeprovisionRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DeprovisionRefused'
  }
}

/**
 * Deprovision one account on the log (ID-5, I4, I14, WF-5): the engine
 * releases each task the person holds through `task.released@1` with the
 * reason and records `user.deprovisioned@1`; the operations land in one
 * transaction. The caller has already made the directory stop holding the
 * account (the API disables it; the sync found it disabled or gone). An
 * account the log already names deprovisioned appends nothing (I1). Without
 * an actor the directory itself deprovisions.
 */
export async function deprovisionPrincipal(
  pool: Pool,
  principal: ActorId,
  now: number,
  by?: DeprovisionActor
): Promise<DeprovisionOutcome> {
  const log = await readLog(pool)
  if (deprovisionedOf(log).has(principal)) {
    return { principal, released: [], alreadyDeprovisioned: true }
  }
  const held: ProjectedInstance[] = []
  for (const instanceId of await instancesHeldBy(pool, principal)) {
    const instance = instanceOf(log, instanceId)
    if (instance !== undefined && instance.holder === principal) held.push(instance)
  }
  const deps: OperationDeps = { clock: () => now, ids: () => newOperationId(now) }
  const result = deprovision(
    principal,
    () => [],
    held,
    deps,
    by === undefined ? {} : { actor: by.actor, grants: by.grants }
  )
  if (!result.accepted || result.operation === undefined) {
    throw new DeprovisionRefused(result.reason ?? 'the deprovision was refused')
  }
  await appendOperations(pool, [...result.releases, result.operation])
  const released = result.operation.payload.released
  return {
    principal,
    released: Array.isArray(released)
      ? (released as readonly { readonly instanceId: string; readonly step: string }[])
      : [],
  }
}

/** What one scheduled pass changed (ID-5). */
export type SyncReport = {
  /** The accounts the pass visited. */
  readonly visited: number
  /** The accounts the pass deprovisioned: disabled or deleted in the directory. */
  readonly deprovisioned: readonly ActorId[]
  /** The accounts the pass provisioned again: held by the directory after a deprovision. */
  readonly provisioned: readonly ActorId[]
}

/**
 * Synchronize every known account with the directory (ID-5, ID-4, #267). A
 * person the directory holds and enables has their profile and groups
 * recorded when they changed, exactly as a sign-in records them, and is
 * provisioned again when the log named them deprovisioned. A person the
 * directory disabled or no longer holds is deprovisioned, with their tasks
 * back in the pool. Each account is read by its id, so a listing that is cut
 * short never makes a person look gone.
 */
export async function syncDirectory(pool: Pool, config: Config, now: number): Promise<SyncReport> {
  const groupsOf = new Map<string, string[]>()
  for (const group of await listDirectoryGroups(config)) {
    for (const member of group.members) {
      const held = groupsOf.get(member.id)
      if (held === undefined) groupsOf.set(member.id, [group.id])
      else held.push(group.id)
    }
  }
  const principals = await listPrincipals(pool)
  const gone = deprovisionedOf(await readLog(pool))
  const deprovisioned: ActorId[] = []
  const provisioned: ActorId[] = []
  for (const principal of principals) {
    const user = await directoryUser(config, principal.id)
    if (user === undefined || user.status === 'disabled') {
      if (gone.has(principal.id)) continue
      await deprovisionPrincipal(pool, principal.id, now)
      deprovisioned.push(principal.id)
      continue
    }
    if (gone.has(principal.id)) {
      await appendOperation(
        pool,
        createOperation(
          USER_PROVISIONED,
          { principal: principal.id },
          { clock: () => now, ids: () => newOperationId(now) },
          DIRECTORY_ACTOR
        )
      )
      provisioned.push(principal.id)
    }
    await upsertPrincipal(pool, {
      id: principal.id,
      displayName: user.displayName === '' ? principal.displayName : user.displayName,
      ...(user.email === ''
        ? principal.email === undefined
          ? {}
          : { email: principal.email }
        : { email: user.email }),
      groups: [...(groupsOf.get(principal.id) ?? [])].sort(),
    })
  }
  return { visited: principals.length, deprovisioned, provisioned }
}

/**
 * The directory seam of one request's resolver (ID-5, AS-1, #267): the
 * accounts the log names deprovisioned resolve to nobody, and the manager of
 * each named starter is read from the directory once, so `manager-of:starter`
 * resolves without a directory read inside the pure resolver.
 */
export async function directoryFor(
  config: Config,
  log: Log,
  starters: readonly (string | undefined)[]
): Promise<ResolverDirectory> {
  const gone = deprovisionedOf(log)
  const managers = new Map<string, string | undefined>()
  for (const starter of new Set(starters)) {
    if (starter === undefined || starter === '') continue
    try {
      managers.set(starter, (await directoryUser(config, starter))?.managerId)
    } catch {
      // A directory that cannot be read names no manager for this request:
      // the step goes to Unroutable with the reason, never to a guess (I10).
      managers.set(starter, undefined)
    }
  }
  return {
    provisioned: (principal) => !gone.has(principal),
    managerOf: (principal) => managers.get(principal),
  }
}
