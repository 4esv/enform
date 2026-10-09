// Issue #38, S01, DF-1, DF-2, DF-4, VT-6, I9, I13, I14: the flow lifecycle.
//
// Scaffold. The types, `createFlow` and `validate` are in place. `push` and
// `publish` arrive with the implementation; the lifecycle check in
// `stories/S01-publish-flow/scenario.test.ts` is marked expected to fail until
// then (CONTRIBUTING.md: a failing test before the implementation).

import { type FlowDefinition, parse } from './definition.js'
import type { ActorId, Operation, OperationDeps } from './operation.js'

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

/** Push a definition to the draft (DF-4, I14). The implementation arrives with issue #38. */
export function push(
  _flow: Flow,
  _definition: FlowDefinition,
  _deps: OperationDeps,
  _actor: ActorId
): PushedFlow {
  throw new Error('flow: push is not implemented yet (issue #38)')
}

/** Publish the draft as the next immutable version (DF-2, VT-6). The implementation arrives with issue #38. */
export function publish(_flow: Flow, _deps: OperationDeps, _actor: ActorId): PublishedFlow {
  throw new Error('flow: publish is not implemented yet (issue #38)')
}
