// Issue #45, S08, AS-1, AS-4, AS-5, ID-4, I6, I10, I13: resolve the targets of
// a step to the principals that they name.
//
// SCAFFOLD (issue #45, commit 1). The types and the signatures below are the
// ones the check compiles against. The bodies are the failing first check's
// scaffold: they do not resolve yet, so `stories/S08-route/scenario.test.ts`
// genuinely fails. The change that closes the issue replaces every body with
// the resolver, the live vs once split and the unroutable reason.
//
// AS-1 fixes six target kinds. AS-4 splits two behaviors: a group or a team
// resolves live, a dynamic target resolves once. Resolution is a pure function
// of the target, the membership and the context (I6).

import type { ConditionData } from './condition.js'
import type { FlowStep, Target } from './definition.js'
import type { Assignee } from './instance.js'
import type { TargetResolver } from './routing.js'

/**
 * The directory membership that a target resolves against (AS-1, AS-4, ID-4).
 * It maps one principal ID, a user, a group or a team, to the member IDs that
 * it holds now.
 */
export type Membership = (principal: string) => readonly string[]

/**
 * The instance context that a dynamic target reads (AS-1, AS-4). A `field`
 * target reads the principal at its key in `data`; `starter` and
 * `manager-of:starter` name the principals of the run.
 */
export type TargetContext = {
  /** The data of the instance: a `field` target reads its key here (AS-1). */
  readonly data: ConditionData
  /** The principal that started the instance: `starter` resolves to it (AS-1). */
  readonly starter: string
  /** The manager of the starter: `manager-of:starter` resolves to it (AS-1). */
  readonly managerOf: string
}

/** Whether a target resolves live (AS-4): a group or a team. */
export function isLiveTarget(_target: Target): boolean {
  return false
}

/** Resolve one target to the principals that it names (AS-1, AS-4). SCAFFOLD: resolves to nobody. */
export function resolveTarget(
  _target: Target,
  _membership: Membership,
  _context: TargetContext
): readonly string[] {
  return []
}

/** Build the resolver that a step resolves through (AS-1, AS-4). SCAFFOLD: resolves to nobody. */
export function createResolver(_membership: Membership, _context: TargetContext): TargetResolver {
  return () => []
}

/** Re-resolve the live targets of an instance to their current members (AS-4). SCAFFOLD: a no-op. */
export function refreshAssignees(
  assignees: readonly Assignee[],
  _membership: Membership
): readonly Assignee[] {
  return [...assignees]
}

/** The reason that the timeline records for an unroutable task (AS-5, A8, I10). SCAFFOLD: empty. */
export function unroutableReason(_step: FlowStep, _assignees: readonly Assignee[]): string {
  return ''
}
