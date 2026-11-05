// Issue #41, S04, DF-2, DF-6, I6: the version of a definition and the draft rebind.
//
// DF-2 pins an instance to the definition version that it started on: a
// published version is immutable, so a later publication cannot reach an
// instance that already started. DF-6 moves a draft that is not yet submitted
// to the new version, and a submitted instance stays where it is. This module
// names the difference between two published versions and rebinds one draft
// instance to the next version. Both functions are pure (I6): they read no
// clock and no random source.
//
// Issue #256, RT-6: the rebind keeps every value, reports the values that do
// not fit the new request form and the new required fields, and records the
// move as an attributed operation on the log.

import { fieldsOf } from './definition.js'
import { classifyChange, type DefinitionChange } from './edit.js'
import { validateField } from './fields.js'
import type { FlowVersion } from './flow.js'
import type { Instance } from './instance.js'
import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'

/**
 * Name the difference between two published versions (DF-6). It delegates to
 * `classifyChange` on the two frozen definitions, so the difference names the
 * structural or edit-class change from `from` to `to` (DF-6, AC-1).
 */
export function versionDiff(from: FlowVersion, to: FlowVersion): readonly DefinitionChange[] {
  return classifyChange(from.definition, to.definition)
}

/** The versioned event type of a draft rebind (RT-6, S04, #256). */
export const DRAFT_REBOUND = 'draft.rebound@1'

/** One value that does not fit the new version (RT-6): the field key and why. */
export type Misfit = {
  readonly key: string
  readonly reason: string
}

/** The result of a rebind (RT-6): the draft on the new version, the operation, and what the author must see. */
export type RebindResult = {
  readonly accepted: boolean
  readonly instance: Instance
  readonly operation?: Operation
  readonly misfits: readonly Misfit[]
  readonly newRequired: readonly string[]
  readonly reason?: string
}

/**
 * Move one draft to the next published version (RT-6, S04, DF-2, DF-6, A7,
 * I4). Only a draft that is not submitted moves; a submitted instance stays
 * on its version, and a draft already on the version is a no-op. The draft
 * keeps every value it holds: the engine deletes nothing (A7). It reports the
 * values that do not fit the new version's request form (a field that is no
 * longer part of the form, or a value that fails its new control) and the
 * required fields of the new form that the draft leaves empty, so the author
 * sees them. The rebind is an attributed operation on the log that the
 * projection folds (I4, I14). It is pure and deterministic (I6).
 */
export function rebindDraft(
  instance: Instance,
  actor: ActorId,
  next: FlowVersion,
  deps: OperationDeps
): RebindResult {
  const none = { instance, misfits: [], newRequired: [] }
  if (instance.submitted !== false) {
    return { ...none, accepted: false, reason: 'a submitted instance stays on its version (DF-2)' }
  }
  if (instance.definitionVersion === next.contentHash) {
    return { ...none, accepted: false, reason: 'the draft is already on this version' }
  }
  const form = next.definition.steps[0]
  const fields = form === undefined ? [] : fieldsOf(form)
  const values = instance.values ?? {}
  const misfits: Misfit[] = []
  for (const [key, value] of Object.entries(values)) {
    const field = fields.find((candidate) => candidate.key === key)
    if (field === undefined) {
      misfits.push({ key, reason: 'the field is no longer part of the form' })
      continue
    }
    if (validateField(field, value) !== undefined) {
      misfits.push({
        key,
        reason: `the value ${JSON.stringify(value)} does not fit the ${field.control} control`,
      })
    }
  }
  const newRequired = fields
    .filter((field) => field.required === true)
    .map((field) => field.key)
    .filter((key) => values[key] === undefined || values[key] === null || values[key] === '')
  const change = {
    instanceId: instance.instanceId,
    from: instance.definitionVersion,
    definitionVersion: next.contentHash,
    misfits,
    newRequired,
  }
  return {
    accepted: true,
    instance: { ...instance, definitionVersion: next.contentHash },
    operation: createOperation(DRAFT_REBOUND, change, deps, actor),
    misfits,
    newRequired,
  }
}

/**
 * Move one draft instance to the next published version (DF-6). The instance
 * records the content hash of the new version, so it continues on v2 while a
 * submitted instance stays on v1 (DF-2). It is pure (I6): it returns a new
 * instance and reads no clock and no random source. The caller rebinds only a
 * draft that is not submitted; a submitted instance is never passed here.
 */
export function migrateDraft(instance: Instance, nextVersion: FlowVersion): Instance {
  return { ...instance, definitionVersion: nextVersion.contentHash }
}
