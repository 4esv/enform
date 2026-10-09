// Issue #19, I13, DF-2, AS-4, A8: the stamped instance record.
// Issue #43, S06, WF-1: the workflow state of an instance, its current step
// and its submitted flag.

import { createHash } from 'node:crypto'
import { type FlowDefinition, serialize, type Target } from './definition.js'

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
  /**
   * The key of the step that the instance is on (WF-1, S06). It is absent
   * before a start routes the draft, and a start sets it to the first step
   * whose skip condition is false (S06).
   */
  readonly currentStep?: string
  /**
   * Whether the instance is submitted (S06, DF-6). It is absent before a
   * submit and true after one; a submitted instance is in progress, and only a
   * draft that is not submitted rebinds to the next version (DF-6).
   */
  readonly submitted?: boolean
}

/**
 * The content hash of a definition (DF-2): the SHA-256 of the canonical file
 * form, in lowercase hex. It is deterministic, and it reads no random source
 * (I6).
 */
export function contentHash(definition: FlowDefinition): string {
  return createHash('sha256').update(serialize(definition)).digest('hex')
}

/**
 * Create an instance from a definition and its resolved assignees (I13,
 * DF-2). The instance records the content hash of the definition as its
 * version, so it stays on the version that it started on (DF-2).
 */
export function createInstance(
  definition: FlowDefinition,
  assignees: readonly Assignee[]
): Instance {
  return {
    definitionVersion: contentHash(definition),
    assignees: [...assignees],
    connectorCalls: [],
  }
}

/**
 * Append one connector call to an instance (I13, I4). The log grows by one
 * entry; the past entries stay as they were.
 */
export function recordConnectorCall(instance: Instance, call: ConnectorCall): Instance {
  return { ...instance, connectorCalls: [...instance.connectorCalls, call] }
}
