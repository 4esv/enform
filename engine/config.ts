// Issue #20, I14, A8, AC-2, ADR 0004: configuration changes as operations.

import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'

/**
 * The kinds of change that affect behavior (I14): definitions, connectors,
 * grants, teams, templates and settings. AC-2 names grant changes in
 * particular. Each one is one operation on the log.
 */
export const CONFIG_KINDS = [
  'definition',
  'connector',
  'grant',
  'team',
  'template',
  'setting',
] as const

/** One kind of configuration change (I14). */
export type ConfigKind = (typeof CONFIG_KINDS)[number]

/** The versioned event type of one configuration change (MVP.md 9.1). */
export function configType(kind: ConfigKind): string {
  return `config.${kind}.changed@1`
}

/** One configuration change, and the principal who made it (I14). */
export type ConfigChange = {
  readonly kind: ConfigKind
  readonly actor: ActorId
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * Create the operation that records one configuration change (I14, AC-2).
 */
export function configOperation(change: ConfigChange, deps: OperationDeps): Operation {
  return createOperation(configType(change.kind), change.payload, deps, change.actor)
}
