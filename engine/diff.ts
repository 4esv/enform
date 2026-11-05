// Issue #264, S03, S04, DF-6, I4, I6, I14: the attributed difference between
// two points of a flow's history.
//
// Each version shows a field-level difference from its parent (DF-6), and
// the difference names the author of each change (S03). The log holds every
// push and every publication of a flow with its actor and time (I4, I14), so
// the diff is read from the log alone: the net changes between the two
// points come from `classifyChange`, and each path is attributed to the last
// push between the points that changed it. A point is a published version
// number or `draft`. The parent of a version is the version before it, the
// parent of the draft is the newest version, and the first version has no
// parent: it differs from the empty flow, so every step of it is new. The
// function is pure (I6).

import { DEFINITION_CHANGED, type FlowDefinition, SCHEMA_VERSION } from './definition.js'
import { classifyChange, type DefinitionChange } from './edit.js'
import { DEFINITION_PUBLISHED } from './flow.js'
import type { ActorId, Log } from './operation.js'

/** One point of a flow's history: a published version number or the draft (DF-6). */
export type VersionRef = number | 'draft'

/** One change between two points, with the author and the time of the push that made it (S03, I14). */
export type AttributedChange = DefinitionChange & {
  readonly actor?: ActorId
  readonly at?: number
}

/** The difference between two points of a flow's history (DF-6). */
export type DefinitionDiff = {
  readonly from: VersionRef
  readonly to: VersionRef
  readonly changes: readonly AttributedChange[]
}

/** One record of the flow's history: a push or a publication, in log order. */
type Record_ = {
  readonly definition: FlowDefinition
  readonly actor?: ActorId
  readonly at: number
  /** The version number a publication froze; absent on a push. */
  readonly version?: number
}

/**
 * The attributed difference from one point to another (DF-6, S03). `from`
 * absent means the parent of `to`. An unknown flow or version gives
 * undefined; the same point twice gives no change.
 */
export function definitionDiff(
  log: Log,
  slug: string,
  from: VersionRef | undefined,
  to: VersionRef
): DefinitionDiff | undefined {
  const records = historyOf(log, slug)
  if (records.length === 0) return undefined
  const toIndex = indexOf(records, to)
  if (toIndex === undefined) return undefined
  const fromRef = from ?? parentOf(records, to)
  const fromIndex = fromRef === undefined ? -1 : indexOf(records, fromRef)
  if (fromIndex === undefined) return undefined
  const fromDefinition = fromIndex < 0 ? EMPTY : records[fromIndex].definition
  const net = classifyChange(fromDefinition, records[toIndex].definition)
  // Each path is attributed to the last record between the points that
  // changed it; a change under a path that one record changed as a whole
  // (a step or a field it added) takes that record.
  const authors = new Map<string, { actor?: ActorId; at: number }>()
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    const record = records[index]
    const previous = index === 0 ? EMPTY : records[index - 1].definition
    for (const change of classifyChange(previous, record.definition)) {
      authors.set(change.path, { actor: record.actor, at: record.at })
    }
  }
  const changes = net.map((change): AttributedChange => {
    const author = authorOf(authors, change.path)
    return author === undefined
      ? change
      : { ...change, ...(author.actor === undefined ? {} : { actor: author.actor }), at: author.at }
  })
  return { from: fromRef ?? to, to, changes }
}

/** The empty flow: the parent of the first version. */
const EMPTY: FlowDefinition = { schemaVersion: SCHEMA_VERSION, steps: [] }

/** Every push and publication of one flow, in log order (I4). */
function historyOf(log: Log, slug: string): readonly Record_[] {
  const records: Record_[] = []
  for (const event of log) {
    if (event.type === DEFINITION_CHANGED && event.payload.flow === slug) {
      records.push({
        definition: event.payload.definition as FlowDefinition,
        actor: event.actor,
        at: event.at,
      })
    } else if (event.type === DEFINITION_PUBLISHED && event.payload.slug === slug) {
      records.push({
        definition: event.payload.definition as FlowDefinition,
        actor: event.actor,
        at: event.at,
        version: event.payload.version as number,
      })
    }
  }
  return records
}

/** The index of one point in the history: a version's publication, or the last record for the draft. */
function indexOf(records: readonly Record_[], ref: VersionRef): number | undefined {
  if (ref === 'draft') return records.length - 1
  const index = records.findIndex((record) => record.version === ref)
  return index < 0 ? undefined : index
}

/** The parent of a point: the version before it, or the newest version before the draft. */
function parentOf(records: readonly Record_[], ref: VersionRef): VersionRef | undefined {
  if (ref === 'draft') {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const version = records[index].version
      if (version !== undefined) return version
    }
    return undefined
  }
  return ref > 1 ? ref - 1 : undefined
}

/** The author of a path: its own record, or the record of the nearest path above it. */
function authorOf(
  authors: ReadonlyMap<string, { actor?: ActorId; at: number }>,
  path: string
): { actor?: ActorId; at: number } | undefined {
  let at = path
  while (at !== '') {
    const author = authors.get(at)
    if (author !== undefined) return author
    at = at.slice(0, at.lastIndexOf('/'))
  }
  return undefined
}
