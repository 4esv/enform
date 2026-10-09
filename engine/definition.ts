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
 */
export function parse(text: string): FlowDefinition {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('flow definition: the document is not valid JSON')
  }
  return readDefinition(value)
}

/**
 * Serialize a definition to its canonical file form (I9, DF-4). The form is
 * stable and byte-for-byte reproducible: the flow, a step and a target have a
 * fixed key order, a nested JSON Logic expression sorts its object keys, the
 * indent is two spaces, and the file ends with one newline. `parse` then
 * `serialize` reproduces a canonical file exactly (I9).
 */
export function serialize(definition: FlowDefinition): string {
  return `${JSON.stringify(canonicalDefinition(definition), null, 2)}\n`
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

/** Read a definition from parsed JSON, and reject a document the format does not allow. */
function readDefinition(body: unknown): FlowDefinition {
  if (!isRecord(body)) throw new Error('flow definition: the document is not an object')
  if (body.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`flow definition: schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (!Array.isArray(body.steps)) throw new Error('flow definition: steps must be an array')
  return { schemaVersion: SCHEMA_VERSION, steps: body.steps.map(readStep) }
}

/** Read one step: a key, its targets, and the optional outcomes and skip condition. */
function readStep(body: unknown): FlowStep {
  if (!isRecord(body)) throw new Error('flow definition: a step is not an object')
  if (typeof body.key !== 'string') throw new Error('flow definition: a step has no key')
  const step: {
    key: string
    targets: readonly Target[]
    outcomes?: readonly string[]
    skipWhen?: JsonValue
  } = { key: body.key, targets: readTargets(body.targets) }
  const outcomes = readOutcomes(body.outcomes)
  if (outcomes !== undefined) step.outcomes = outcomes
  if (body.skipWhen !== undefined) step.skipWhen = body.skipWhen as JsonValue
  return step
}

/** Read the targets of a step. */
function readTargets(body: unknown): readonly Target[] {
  if (!Array.isArray(body)) throw new Error('flow definition: targets must be an array')
  return body.map(readTarget)
}

/** Read one target: exactly one kind key, whose value is a string (AS-1). */
function readTarget(body: unknown): Target {
  if (!isRecord(body)) throw new Error('flow definition: a target is not an object')
  const keys = Object.keys(body)
  if (keys.length !== 1) throw new Error('flow definition: a target names exactly one kind')
  const kind = keys[0]
  if (!TARGET_KINDS.includes(kind as TargetKind)) {
    throw new Error(`flow definition: ${kind} is not a target kind (AS-1)`)
  }
  if (typeof body[kind] !== 'string') {
    throw new Error('flow definition: a target value must be a string')
  }
  // The one key is a TargetKind, which the check above established.
  return { [kind]: body[kind] } as Target
}

/** Read the optional outcomes of a step (WF-2). */
function readOutcomes(body: unknown): readonly string[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body) || body.some((name) => typeof name !== 'string')) {
    throw new Error('flow definition: outcomes must be an array of strings')
  }
  return body as string[]
}

/** The canonical value of a definition: the fixed key order of the flow format. */
function canonicalDefinition(definition: FlowDefinition): JsonValue {
  return {
    schemaVersion: definition.schemaVersion,
    steps: definition.steps.map(canonicalStep),
  }
}

/** The canonical value of one step: key, targets, then the optional outcomes and skip condition. */
function canonicalStep(step: FlowStep): JsonValue {
  const canonical: Record<string, JsonValue> = {
    key: step.key,
    targets: step.targets.map((target) => ({ ...target })),
  }
  if (step.outcomes !== undefined) canonical.outcomes = [...step.outcomes]
  if (step.skipWhen !== undefined) canonical.skipWhen = canonicalJson(step.skipWhen)
  return canonical
}

/** The canonical value of a JSON Logic expression: the same value with sorted object keys. */
function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (isRecord(value)) {
    const sorted: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key])
    return sorted
  }
  return value
}

/** A JSON object: not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
