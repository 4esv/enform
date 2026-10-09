// Issue #38, S01, DF-1, DF-2, DF-4, VT-6, I9, I13, I14: the flow lifecycle.
// Issue #40, S03, DF-5, D2, AC-1: the scope guard on a push.
//
// A flow has one draft definition and, once published, immutable versions
// (DF-1, DF-2). `push` replaces the draft and records one
// config.definition.changed@1 operation (DF-4, I14). `publish` freezes the
// draft into version N with a content hash and records one
// config.definition.published@1 operation (DF-2, VT-6). A later push opens a
// new draft; a published version never changes, so an instance created from it
// stays on it (I13).
//
// A push is scope-guarded when the caller passes the acting principal's grants
// (DF-5, D2, AC-1): an edit-class change needs `flow.edit` and a structural
// change needs `flow.build`. The classification lives in `edit.ts`; the engine
// is the only place that evaluates it (AC-1).

import { authorize, type Grant } from './authorize.js'
import { configOperation } from './config.js'
import { type FlowDefinition, parse, serialize } from './definition.js'
import { classifyChange, type DefinitionChange } from './edit.js'
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
 *
 * `grants` are the scopes that apply to the acting principal (AC-1). When they
 * are given, the push is scope-guarded (DF-5, D2): an edit-class change needs
 * `flow.edit`, a structural change needs `flow.build`, and a refusal names the
 * change and the scope. When they are absent the engine records the change
 * unchecked; the first draft creation and the lifecycle tests use that path,
 * and the API always passes the acting principal's grants.
 */
export function push(
  flow: Flow,
  definition: FlowDefinition,
  deps: OperationDeps,
  actor: ActorId,
  grants?: readonly Grant[]
): PushedFlow {
  if (grants !== undefined) assertPushAllowed(flow, definition, grants)
  const operation = configOperation({ kind: 'definition', actor, payload: definition }, deps)
  return { flow: { ...flow, draft: definition }, operation }
}

/**
 * Authorize one push against the acting principal's grants (DF-5, D2, AC-1,
 * I8). The engine is the only place that evaluates the scope of a definition
 * change (AC-1). A structural change needs `flow.build`. An edit-class change
 * needs `flow.edit`; `flow.build` also covers it, because it allows all
 * changes (D2). The error names the structural changes and the scope they need.
 */
function assertPushAllowed(flow: Flow, definition: FlowDefinition, grants: readonly Grant[]): void {
  const resource = `flow:${flow.slug}`
  const changes: readonly DefinitionChange[] =
    flow.draft === undefined
      ? [{ class: 'structural', message: 'the first draft was created' }]
      : classifyChange(flow.draft, definition)
  const structural = changes.filter((change) => change.class === 'structural')
  if (structural.length > 0) {
    if (!authorize(grants, 'flow.build', resource)) {
      const named = structural.map((change) => change.message).join('; ')
      throw new Error(
        `flow: the push makes a structural change (${named}); it requires the scope flow.build`
      )
    }
    return
  }
  if (!authorize(grants, 'flow.edit', resource) && !authorize(grants, 'flow.build', resource)) {
    throw new Error('flow: the push makes an edit-class change; it requires the scope flow.edit')
  }
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
