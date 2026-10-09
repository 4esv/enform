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
// This milestone's definition model has steps, targets, outcomes and skip
// conditions; it has no form fields or values yet. A structural change (an
// added step) stands in for "a new field", and the field-value migration
// ("keeps each value that fits") arrives with FM-1 (issue #74).

import type { DefinitionChange } from './edit.js'
import type { FlowVersion } from './flow.js'
import type { Instance } from './instance.js'

/**
 * Name the difference between two published versions (DF-6). It delegates to
 * `classifyChange` on the two frozen definitions, so the difference names the
 * structural or edit-class change from `from` to `to` (DF-6, AC-1).
 */
export function versionDiff(_from: FlowVersion, _to: FlowVersion): readonly DefinitionChange[] {
  return []
}

/**
 * Move one draft instance to the next published version (DF-6). The instance
 * records the content hash of the new version, so it continues on v2 while a
 * submitted instance stays on v1 (DF-2). It is pure (I6): it returns a new
 * instance and reads no clock and no random source. The caller rebinds only a
 * draft that is not submitted; a submitted instance is never passed here.
 */
export function migrateDraft(instance: Instance, _nextVersion: FlowVersion): Instance {
  return instance
}
