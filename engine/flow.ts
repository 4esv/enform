// Issue #38, S01, DF-1, DF-2, DF-4, VT-6, I9, I13, I14: the flow lifecycle.
//
// A flow has one draft definition and, once published, immutable versions
// (DF-1, DF-2). `push` replaces the draft and records one
// config.definition.changed@1 operation (DF-4, I14). `publish` freezes the
// draft into version N with a content hash and records one
// config.definition.published@1 operation (DF-2, VT-6). A later push opens a
// new draft; a published version never changes, so an instance created from it
// stays on it (I13).

import { configOperation } from './config.js'
import { type FlowDefinition, parse, serialize } from './definition.js'
import { contentHash } from './instance.js'
import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'

/** The versioned event type of a publication (DF-2, VT-6). */
export const DEFINITION_PUBLISHED = 'config.definition.published@1'

/** One immutable published version of a flow (DF-2). */
export type FlowVersion = {
  /** The version number, from 1 up (DF-2). */
  readonly version: number
  /** The content hash of the frozen definition, in lowercase hex (DF-2). */
  readonly contentHash: string
  /** The frozen definition; a later push opens a new draft instead (DF-2). */
  readonly definition: FlowDefinition
}

/** The state of one flow: its slug, its draft and its published versions (DF-1, DF-2). */
export type Flow = {
  /** The flow slug (ID-1). */
  readonly slug: string
  /** The draft definition, absent before the first push (DF-4). */
  readonly draft?: FlowDefinition
  /** The published versions, oldest first, so version N is at index N-1 (DF-2). */
  readonly versions: readonly FlowVersion[]
}

/** The result of a push: the new flow state and the operation that recorded it (DF-4, I14). */
export type PushedFlow = {
  readonly flow: Flow
  readonly operation: Operation
}

/** The result of a publish: the new flow state and the operation that recorded it (DF-2, VT-6). */
export type PublishedFlow = {
  readonly flow: Flow
  readonly operation: Operation
}

/** The payload of a publication (VT-6): the slug, the version, the hash and the frozen definition. */
type PublicationPayload = {
  readonly slug: string
  readonly version: number
  readonly contentHash: string
  readonly definition: FlowDefinition
}

/** A new flow with an empty draft and no published version (DF-1). */
export function createFlow(slug: string): Flow {
  return { slug, versions: [] }
}

/**
 * Validate a definition file (DF-1). It parses the file and returns the
 * definition; an invalid file throws with the error that names the offending
 * field. It reads no state and writes none.
 */
export function validate(text: string): FlowDefinition {
  return parse(text)
}

/**
 * Push a definition to the draft (DF-4, I14). One config.definition.changed@1
 * operation records the change, attributed to the actor. The draft becomes the
 * pushed definition; the published versions stay as they were.
 */
export function push(
  flow: Flow,
  definition: FlowDefinition,
  deps: OperationDeps,
  actor: ActorId
): PushedFlow {
  const operation = configOperation({ kind: 'definition', actor, payload: definition }, deps)
  return { flow: { ...flow, draft: definition }, operation }
}

/**
 * Publish the draft as the next immutable version (DF-2, VT-6). One
 * config.definition.published@1 operation records the version, its content
 * hash and the frozen definition, attributed to the actor. The frozen
 * definition is a fresh parse, so a later change to the draft cannot reach the
 * version; a later push opens a new draft.
 */
export function publish(flow: Flow, deps: OperationDeps, actor: ActorId): PublishedFlow {
  const draft = flow.draft
  if (draft === undefined) {
    throw new Error('flow: the draft is empty; push a definition before publishing')
  }
  const frozen = parse(serialize(draft))
  const version = flow.versions.length + 1
  const hash = contentHash(frozen)
  const published: FlowVersion = { version, contentHash: hash, definition: frozen }
  const payload: PublicationPayload = {
    slug: flow.slug,
    version,
    contentHash: hash,
    definition: frozen,
  }
  const operation = createOperation(DEFINITION_PUBLISHED, payload, deps, actor)
  return { flow: { ...flow, versions: [...flow.versions, published] }, operation }
}
