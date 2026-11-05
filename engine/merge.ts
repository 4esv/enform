// Issue #264, S03, DF-3, I1, I4, I6: the three-way merge of two draft edits.
//
// More than one person edits a draft definition at the same time (DF-3), and
// nobody is blocked (S03): a write that is based on an older draft merges
// with the draft the other write left. The merge is three-way: the base is
// the draft the writer read, ours is the write, theirs is the current draft.
// A place only one side changed lands as that side made it. A place both
// sides changed the same way lands once. A place both sides changed
// differently is a conflict that names its path, and a merge with a conflict
// gives no definition, so the writer re-reads and decides (A1).
//
// The merge walks the definition by its structure: objects by property, the
// keyed lists (steps, sections, fields) by key, and everything else (a scalar,
// a target list, a condition, an option list) as one value. A path has the
// shape that `classifyChange` reports (DF-6): `/steps/request/fields/summary/label`.
//
// A writer names its base by the content hash of the draft it read, and the
// log holds every draft a push or a publication recorded, so the base reads
// back from the log (I4). Both functions are pure (I6).

import { DEFINITION_CHANGED, type FlowDefinition, type JsonValue } from './definition.js'
import { DEFINITION_PUBLISHED } from './flow.js'
import { contentHash } from './instance.js'
import type { Log } from './operation.js'

/** One place both sides changed differently (S03): its path and the three values. */
export type MergeConflict = {
  readonly path: string
  readonly base?: JsonValue
  readonly ours?: JsonValue
  readonly theirs?: JsonValue
}

/** The result of a merge: the merged definition, or the conflicts that prevent one. */
export type MergeResult = {
  readonly definition?: FlowDefinition
  readonly conflicts: readonly MergeConflict[]
}

/**
 * Merge two edits of one base definition (DF-3, S03). `ours` is the write
 * that arrives second and `theirs` the draft the first write left; the merge
 * is symmetric except for the order of additions, which places ours first.
 * It returns the merged definition when the two edits touch different
 * places or agree, and the conflicts when they do not.
 */
export function mergeDefinitions(
  base: FlowDefinition,
  ours: FlowDefinition,
  theirs: FlowDefinition
): MergeResult {
  const conflicts: MergeConflict[] = []
  const merged = mergeValue(
    base as unknown as JsonValue,
    ours as unknown as JsonValue,
    theirs as unknown as JsonValue,
    '',
    conflicts
  )
  if (conflicts.length > 0) return { conflicts }
  return { definition: merged as unknown as FlowDefinition, conflicts }
}

/**
 * The definition the log recorded under one content hash for one flow (I4):
 * a draft that a push recorded or a version that a publication froze. The
 * log is scanned from its end, so the newest record answers first; a hash the
 * log does not hold for that flow gives undefined.
 */
export function definitionByHash(log: Log, slug: string, hash: string): FlowDefinition | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event.type === DEFINITION_PUBLISHED) {
      if (event.payload.slug !== slug || event.payload.contentHash !== hash) continue
      return event.payload.definition as FlowDefinition
    }
    if (event.type !== DEFINITION_CHANGED || event.payload.flow !== slug) continue
    const definition = event.payload.definition as FlowDefinition
    if (contentHash(definition) === hash) return definition
  }
  return undefined
}

/** A value that is absent on one side of the merge. */
type Maybe = JsonValue | undefined

/** Merge one place of the definition; `undefined` means the place is absent. */
function mergeValue(
  base: Maybe,
  ours: Maybe,
  theirs: Maybe,
  path: string,
  conflicts: MergeConflict[]
): Maybe {
  if (same(ours, theirs)) return ours
  if (same(base, ours)) return theirs
  if (same(base, theirs)) return ours
  // Both sides changed the place differently. A removal against a change is
  // a conflict; two objects or two keyed lists merge place by place.
  if (ours === undefined || theirs === undefined) {
    conflicts.push(conflict(path, base, ours, theirs))
    return ours
  }
  if (isRecord(ours) && isRecord(theirs) && (base === undefined || isRecord(base))) {
    return mergeRecords(base ?? {}, ours, theirs, path, conflicts)
  }
  if (isKeyedList(ours) && isKeyedList(theirs) && (base === undefined || isKeyedList(base))) {
    return mergeKeyedLists(base ?? [], ours, theirs, path, conflicts)
  }
  conflicts.push(conflict(path, base, ours, theirs))
  return ours
}

/** Merge two objects property by property, over the union of their keys. */
function mergeRecords(
  base: Readonly<Record<string, JsonValue>>,
  ours: Readonly<Record<string, JsonValue>>,
  theirs: Readonly<Record<string, JsonValue>>,
  path: string,
  conflicts: MergeConflict[]
): JsonValue {
  const merged: Record<string, JsonValue> = {}
  const keys = [...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]
  for (const key of new Set(keys)) {
    const value = mergeValue(base[key], ours[key], theirs[key], `${path}/${key}`, conflicts)
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/** One entry of a keyed list: an object with a string `key`. */
type Keyed = Readonly<Record<string, JsonValue>> & { readonly key: string }

/**
 * Merge two keyed lists (steps, sections, fields) entry by entry. The order is
 * ours, with the entries only theirs added placed after their predecessor
 * in theirs; when both sides reordered the shared entries differently the
 * order is a conflict on the list itself.
 */
function mergeKeyedLists(
  base: readonly Keyed[],
  ours: readonly Keyed[],
  theirs: readonly Keyed[],
  path: string,
  conflicts: MergeConflict[]
): JsonValue {
  const byKey = (list: readonly Keyed[]): Map<string, Keyed> =>
    new Map(list.map((entry) => [entry.key, entry]))
  const baseMap = byKey(base)
  const ourMap = byKey(ours)
  const theirMap = byKey(theirs)
  const order = mergedOrder(
    base.map((entry) => entry.key),
    ours.map((entry) => entry.key),
    theirs.map((entry) => entry.key),
    path,
    conflicts
  )
  const merged: JsonValue[] = []
  for (const key of order) {
    const value = mergeValue(
      baseMap.get(key),
      ourMap.get(key),
      theirMap.get(key),
      `${path}/${key}`,
      conflicts
    )
    if (value !== undefined) merged.push(value)
  }
  return merged
}

/**
 * The key order of a merged keyed list: ours, with the keys only theirs holds
 * inserted after their predecessor in theirs. When ours kept the base order
 * of the shared keys and theirs changed it, theirs wins; when both changed it
 * differently, the order is a conflict.
 */
function mergedOrder(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  path: string,
  conflicts: MergeConflict[]
): readonly string[] {
  const shared = new Set(ours.filter((key) => theirs.includes(key)))
  const ourShared = ours.filter((key) => shared.has(key))
  const theirShared = theirs.filter((key) => shared.has(key))
  const baseShared = base.filter((key) => shared.has(key))
  let leading = ours
  let trailing = theirs
  if (!sameOrder(ourShared, theirShared)) {
    if (sameOrder(ourShared, baseShared)) {
      leading = theirs
      trailing = ours
    } else if (!sameOrder(theirShared, baseShared)) {
      conflicts.push(conflict(path, base, ours, theirs))
    }
  }
  const order = [...leading]
  for (const [index, key] of trailing.entries()) {
    if (order.includes(key)) continue
    const previous = trailing[index - 1]
    let at = previous === undefined ? -1 : order.indexOf(previous)
    // The entries only the leading side added after the predecessor stay
    // before the entry the trailing side added there.
    while (at + 1 < order.length && !trailing.includes(order[at + 1])) at += 1
    order.splice(at + 1, 0, key)
  }
  return order
}

function conflict(path: string, base: Maybe, ours: Maybe, theirs: Maybe): MergeConflict {
  return {
    path: path === '' ? '/' : path,
    ...(base === undefined ? {} : { base }),
    ...(ours === undefined ? {} : { ours }),
    ...(theirs === undefined ? {} : { theirs }),
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKeyedList(value: unknown): value is readonly Keyed[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isRecord(entry) && typeof entry.key === 'string')
  )
}

/** The two lists hold the same values, in the same order. */
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Deep equality for the JSON values of a definition. */
function same(left: Maybe, right: Maybe): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => same(entry, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    return (
      keys.length === Object.keys(right).length && keys.every((key) => same(left[key], right[key]))
    )
  }
  return false
}
