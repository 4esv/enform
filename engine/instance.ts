// Issue #19, I13, DF-2, AS-4, A8: the stamped instance record.
// Issue #43, S06, WF-1: the workflow state of an instance, its current step
// and its submitted flag.
// Issue #46, S09, AS-2, I5: the holder of the current step and the log version
// that a view of the instance was read at.

import { createHash } from 'node:crypto'
import type { Version } from './concurrency.js'
import { type FlowDefinition, type JsonValue, serialize, type Target } from './definition.js'
import type { ActorId } from './operation.js'

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
 * AS-4), an append-only log of connector calls (I13), and the values that the
 * form holds (FM-7). The engine appends to the log; it does not update or
 * delete an entry (I4).
 */
export type Instance = {
  /**
   * The id that identifies the instance (DX-1, #187). The client mints it, as
   * it mints the operation id (ADR 0004), and a start stamps the instance with
   * it, exactly as it stamps the starter and the current step. It is absent
   * before a start sets it, so two starts that give the same instance id are
   * the same instance (I1).
   */
  readonly instanceId?: string
  /**
   * The slug of the flow that the instance runs (#222, I4). A start records it
   * on the event and on the instance, so a read names the flow without
   * searching the log by definition hash, and two flows with identical
   * definitions do not collide.
   */
  readonly flow?: string
  /** The content hash of the definition version that the instance started on (DF-2). */
  readonly definitionVersion: string
  readonly assignees: readonly Assignee[]
  readonly connectorCalls: readonly ConnectorCall[]
  /**
   * The values that the form holds (#177, FM-7): an immutable record of field
   * keys to JSON values. It is absent before a start sets it, a start records
   * the values that it routed with, and a submit merges the step's captured
   * values over what the instance already held.
   */
  readonly values?: Readonly<Record<string, JsonValue>>
  /**
   * The principal that started the instance (S06, AC-5). A start sets it. The
   * starter can always read the instance and, unless the flow prevents it, may
   * withdraw it (WF-4, AC-5).
   */
  readonly starter?: ActorId
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
  /**
   * The principal that holds the current step (S09, AS-2). It is absent before
   * anyone claims the step, the first claim sets it to the claimant, and a
   * completion clears it. Only the holder may complete the step.
   */
  readonly holder?: ActorId
  /**
   * Whether the instance completed its last step (S09, WF-1). It is absent
   * before the last completion and true after one; while a next step remains,
   * the engine advances `currentStep` instead.
   */
  readonly done?: boolean
  /**
   * Whether the instance is withdrawn or cancelled (S13, WF-4). It is absent
   * while the instance is live, `withdrawn` after the starter withdraws it, and
   * `cancelled` after a principal with `instance.cancel` cancels it. It is a
   * marker, never a deletion (I4): the log keeps the event, and an undo clears
   * the marker through a compensating event (WF-5).
   */
  readonly withdrawal?: 'withdrawn' | 'cancelled'
  /**
   * The step that a withdraw or a cancel closed (S13, WF-5). It is present
   * while `withdrawal` is set, and the undo restores it as the current step
   * (I4).
   */
  readonly previousStep?: string
  /**
   * The holder that a withdraw or a cancel closed (S13, WF-5). It is absent
   * when the closed task had no holder; the undo restores it (I4).
   */
  readonly previousHolder?: ActorId
  /**
   * The time of the withdraw or the cancel, from the injected clock (S13, I6).
   * It is present while `withdrawal` is set, and the undo measures the undo
   * period from it (WF-5).
   */
  readonly closedAt?: number
  /**
   * The principal that withdrew or cancelled the instance (S13, I14). It is
   * present while `withdrawal` is set, and only this principal may undo it
   * within the period (WF-5).
   */
  readonly closedBy?: ActorId
  /**
   * The reason that the closer gave for the withdrawal or the cancellation
   * (S13, WF-4). It is present while `withdrawal` is set; the task page shows
   * it to everyone who may read the instance, and the undo clears it with the
   * rest of the close marker (WF-5, I4).
   */
  readonly closeReason?: string
  /**
   * The revision of each step that a send back has revisited (WF-3, S11). It
   * maps a step key to the revision that the instance is on for that step: the
   * first time the engine enters a step is revision 1, and each send back to
   * that step records the next revision. It is absent until a send back records
   * one.
   */
  readonly revisions?: Readonly<Record<string, number>>
  /**
   * The log position that this view of the instance was read at (S09, I5). The
   * engine reads it from the log length (`version` in concurrency.ts), and an
   * action carries it as the version that the actor based its action on. It is
   * absent before an action reads the instance, and an absent version is the
   * empty log, version 0.
   */
  readonly version?: Version
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
 * Fold a step's resolved assignees into an instance (AS-4, I13). An instance
 * records one resolution per step: the entries of every step that `entered`
 * names are replaced by the new ones, and the entries of other steps stay. A
 * step the instance enters again (a send back, WF-3) therefore keeps only its
 * most recent resolution, and a stale entry never keeps an actor authorized.
 * The function is pure and deterministic (I6).
 */
export function recordAssignees<T extends Instance>(instance: T, entered: readonly Assignee[]): T {
  const replaced = new Set(entered.map((assignee) => assignee.step))
  return {
    ...instance,
    assignees: [
      ...instance.assignees.filter((assignee) => !replaced.has(assignee.step)),
      ...entered,
    ],
  }
}

/**
 * Fold added assignees into the set an instance already holds (SE-4, I13). An
 * entry for a target that the step already has gains the members it does not
 * have, and a target that is new adds its entry; no existing entry is removed,
 * because an escalation adds targets and never removes the current owner
 * (SE-4). The function is pure and deterministic (I6).
 */
export function mergeAssignees(
  existing: readonly Assignee[],
  added: readonly Assignee[]
): readonly Assignee[] {
  const merged: Assignee[] = existing.map((entry) => ({
    ...entry,
    members: [...entry.members],
  }))
  for (const entry of added) {
    const key = targetKey(entry.target)
    const index = merged.findIndex((held) => targetKey(held.target) === key)
    if (index === -1) {
      merged.push({ ...entry, members: [...entry.members] })
      continue
    }
    const held = merged[index]
    if (held === undefined) continue
    const members = [...held.members]
    for (const member of entry.members) if (!members.includes(member)) members.push(member)
    merged[index] = { ...held, members }
  }
  return merged
}

/** The stable identity of one target, so an add merges into the entry it names (AS-1). */
function targetKey(target: Target): string {
  const [kind] = Object.keys(target)
  return `${kind}:${String((target as Record<string, string>)[kind])}`
}

/**
 * Append one connector call to an instance (I13, I4). The log grows by one
 * entry; the past entries stay as they were.
 */
export function recordConnectorCall(instance: Instance, call: ConnectorCall): Instance {
  return { ...instance, connectorCalls: [...instance.connectorCalls, call] }
}
