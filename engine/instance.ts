// Issue #19, I13, DF-2, AS-4, A8: the stamped instance record.
//
// I13: each instance records its definition version and the resolved assignees
// with a membership snapshot. It also records a log of connector calls:
// operation, time and outcome. It does not record response bodies. The
// instance stays on the definition version that it started on (DF-2).
//
// Scaffolding for #19: the types below are the record that the oracle checks.
// The three functions are stubs, so the first check of the suite fails until
// the implementation lands in the second commit.

import type { FlowDefinition, Target } from './definition.js'

/**
 * One resolved assignee of a step, with the membership snapshot that the
 * resolution produced (I13, AS-4). A group or a team target records the
 * members that resolved; a dynamic target records its one-time resolution.
 */
export type Assignee = {
  /** The step whose task the assignee can act on (WF-1). */
  readonly step: string
  /** The target that named the assignee (AS-1). */
  readonly target: Target
  /**
   * The principal IDs that resolved at resolution time (AS-4, ID-4). It is
   * empty when the target resolved to nobody (I10).
   */
  readonly members: readonly string[]
}

/**
 * One connector call (I13). It records the operation, the time and the
 * outcome. It does not record a response body.
 */
export type ConnectorCall = {
  /** The connector operation that ran (A2). */
  readonly operation: string
  /** The time of the call, from the injected clock (I6). */
  readonly time: number
  /** What the call resulted in: an outcome, never the response body (I13). */
  readonly outcome: string
}

/**
 * One instance (MVP.md 3). It records the definition version that it started
 * on (DF-2), its resolved assignees with their membership snapshots (I13,
 * AS-4), and an append-only log of connector calls (I13). The engine appends
 * to the log; it does not update or delete an entry (I4).
 */
export type Instance = {
  /** The content hash of the definition version that the instance started on (DF-2). */
  readonly definitionVersion: string
  readonly assignees: readonly Assignee[]
  readonly connectorCalls: readonly ConnectorCall[]
}

/**
 * The content hash of a definition (DF-2): the SHA-256 of the canonical file
 * form, in lowercase hex. It is deterministic, and it reads no random source
 * (I6). Stub: the hash lands with #19.
 */
export function contentHash(_definition: FlowDefinition): string {
  return ''
}

/**
 * Create an instance from a definition and its resolved assignees (I13,
 * DF-2). The instance records the content hash of the definition as its
 * version, so it stays on the version that it started on. Stub: the record
 * lands with #19.
 */
export function createInstance(
  _definition: FlowDefinition,
  _assignees: readonly Assignee[]
): Instance {
  return { definitionVersion: '', assignees: [], connectorCalls: [] }
}

/**
 * Append one connector call to an instance (I13, I4). The log grows by one
 * entry; the past entries stay as they were. Stub: the append lands with #19.
 */
export function recordConnectorCall(instance: Instance, _call: ConnectorCall): Instance {
  return instance
}
