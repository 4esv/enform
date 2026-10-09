// Issue #15, I9, DF-1, DF-4, A3: the flow definition file and its canonical round trip.

import { configType } from './config.js'
import { createOperation, type Operation, type OperationDeps } from './operation.js'

/**
 * One integer `schemaVersion` of the flow definition format (DF-1, MVP.md
 * 9.1). The engine reads every earlier value and writes only the latest
 * (9.3); at this milestone the latest is 1.
 */
export const SCHEMA_VERSION = 1

/** A JSON value, the shape of a JSON Logic expression tree (FM-5, ADR 0008). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** The six kinds of target (AS-1). */
export const TARGET_KINDS = ['user', 'group', 'team', 'field', 'starter', 'manager-of'] as const

/** One kind of target (AS-1). */
export type TargetKind = (typeof TARGET_KINDS)[number]

/**
 * The recipient of a task (MVP.md 3, AS-1). Exactly one key names the kind:
 * `user`, `group` and `team` hold an immutable principal ID (ID-4); `field`
 * holds a form field key; `starter` and `manager-of` are the dynamic targets
 * of AS-1, for example `{ "starter": "starter" }` and
 * `{ "manager-of": "starter" }`.
 */
export type Target =
  | { readonly user: string }
  | { readonly group: string }
  | { readonly team: string }
  | { readonly field: string }
  | { readonly starter: string }
  | { readonly 'manager-of': string }

/**
 * One stage of a flow (MVP.md 3, WF-1, WF-2). `targets` are the recipients of
 * the task that the step creates. `outcomes` are the names an actor can
 * choose (WF-2). `skipWhen` is a JSON Logic expression; when it is true the
 * step is skipped (WF-1, S05).
 */
export type FlowStep = {
  readonly key: string
  readonly targets: readonly Target[]
  readonly outcomes?: readonly string[]
  readonly skipWhen?: JsonValue
}

/** One flow, as one JSON document (DF-1). */
export type FlowDefinition = {
  readonly schemaVersion: number
  readonly steps: readonly FlowStep[]
}

/**
 * Parse a flow definition file to a definition (I9, DF-1). The text is JSON
 * and the format is versioned by its integer `schemaVersion` (9.1). The parse
 * reads the values as written; `serialize` imposes the canonical form, so
 * `serialize(parse(file))` is `file` again for a canonical file (I9).
 *
 * Scaffolding for #15: the parse and serialize pair is not implemented yet, so
 * the round trip is not byte-identical. The implementation commit replaces
 * both with the canonical parser and serializer.
 */
export function parse(_text: string): FlowDefinition {
  return { schemaVersion: SCHEMA_VERSION, steps: [] }
}

/**
 * Serialize a definition to its canonical file form (I9, DF-4). The form is
 * stable and byte-for-byte reproducible: the flow, a step and a target have a
 * fixed key order, a nested JSON Logic expression sorts its object keys, the
 * indent is two spaces, and the file ends with one newline. `parse` then
 * `serialize` reproduces a canonical file exactly (I9).
 *
 * Scaffolding for #15: see `parse`.
 */
export function serialize(_definition: FlowDefinition): string {
  return ''
}

/** The event type of a definition change (I14, via `config.definition`). */
export const DEFINITION_CHANGED = configType('definition')

/**
 * Convert a definition to the operation that records it (I9, I14, DF-4). The
 * payload is the definition itself. The operation omits the actor: the caller
 * that holds the principal adds the attribution, and I14 keeps every
 * behavior-affecting change attributed on the log.
 */
export function definitionToOperation(definition: FlowDefinition, deps: OperationDeps): Operation {
  return createOperation(DEFINITION_CHANGED, definition, deps)
}

/**
 * Convert the operation that records a definition back to a definition (I9).
 * It is the inverse of `definitionToOperation`, so a definition survives the
 * trip to the log and back unchanged.
 */
export function definitionFromOperation(operation: Operation): FlowDefinition {
  if (operation.type !== DEFINITION_CHANGED) {
    throw new Error(`flow definition: ${operation.type} is not ${DEFINITION_CHANGED}`)
  }
  // SAFETY: the type check above admits only a definition change, and
  // definitionToOperation is the only writer of its payload, so the payload is
  // the FlowDefinition that the operation recorded.
  return operation.payload as unknown as FlowDefinition
}
