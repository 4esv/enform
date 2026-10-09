// Issue #45, S08, AS-1, AS-4, AS-5, ID-4, I6, I10, I13: resolve the targets of
// a step to the principals that they name.
//
// AS-1 fixes six target kinds. A `user`, a `group` and a `team` name a
// directory principal, and the injected membership says who it holds now
// (ID-4). A dynamic target, `field`, `starter` or `manager-of`, names a
// principal through the instance: the context resolves the name, and the same
// membership says whether that principal still exists. AS-4 splits the two
// behaviors. A group or a team resolves live: a re-resolution reads the
// membership again, so a member who joined later is included with no new
// publication. A dynamic target resolves once: the instance keeps the members
// that the first resolution recorded (I13). Resolution is a pure function of
// the target, the membership and the context (I6): it reads no clock, no
// random source and no directory of its own.

import type { ConditionData } from './condition.js'
import type { FlowStep, Target } from './definition.js'
import type { Assignee } from './instance.js'
import type { TargetResolver } from './routing.js'

/**
 * The directory membership that a target resolves against (AS-1, AS-4, ID-4).
 * It maps one principal ID, a user, a group or a team, to the member IDs that
 * it holds now. A group or a team maps to its current members; a provisioned
 * user maps to itself; a deprovisioned or unknown principal maps to nobody.
 * The caller injects it, so resolution reads no directory of its own (I6).
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
export function isLiveTarget(target: Target): boolean {
  return livePrincipal(target) !== undefined
}

/**
 * Resolve one target to the principals that it names (AS-1, AS-4). The target
 * names one principal, and the membership returns its members: a group or a
 * team gives its current members, and a user gives itself while the directory
 * holds it. A dynamic target reads its principal from the context first. The
 * function is pure and deterministic (I6), and it returns an empty list when
 * the principal is deprovisioned or unknown, so the caller routes the task to
 * Unroutable (I10, AS-5).
 */
export function resolveTarget(
  target: Target,
  membership: Membership,
  context: TargetContext
): readonly string[] {
  const principal = namedPrincipal(target, context)
  if (principal === undefined) return []
  return membership(principal)
}

/**
 * Build the resolver that a step resolves through (AS-1, AS-4). The resolver
 * reads the membership on every call, so a group or a team target resolves
 * live; the context fixes the dynamic targets, so an instance resolves them
 * once, when the engine creates the task.
 */
export function createResolver(membership: Membership, context: TargetContext): TargetResolver {
  return (target) => resolveTarget(target, membership, context)
}

/**
 * Re-resolve the live targets of an instance to their current members (AS-4).
 * A group or a team is read again through the membership, so a person who
 * joined after the instance was created is included, with no new publication.
 * A dynamic target keeps the one-time members that the instance recorded
 * (I13).
 */
export function refreshAssignees(
  assignees: readonly Assignee[],
  membership: Membership
): readonly Assignee[] {
  return assignees.map((assignee) => {
    const principal = livePrincipal(assignee.target)
    return principal === undefined ? assignee : { ...assignee, members: membership(principal) }
  })
}

/**
 * The reason that the timeline records for an unroutable task (AS-5, A8, I10):
 * the step and the targets that resolved to nobody, so a reader finds why the
 * task is in the queue. It is a pure function of the step and its assignees
 * (I6).
 */
export function unroutableReason(step: FlowStep, assignees: readonly Assignee[]): string {
  const unresolved = assignees
    .filter((assignee) => assignee.members.length === 0)
    .map((assignee) => describeTarget(assignee.target))
  return `step ${step.key}: no target resolved to a current principal (${unresolved.join(', ')})`
}

/** The principal ID that a live target names (AS-4). A dynamic target names none. */
function livePrincipal(target: Target): string | undefined {
  if ('group' in target) return target.group
  if ('team' in target) return target.team
  return undefined
}

/**
 * The principal ID that a target names, before the membership resolves it
 * (AS-1). A `user`, a `group` and a `team` name it directly. `starter` names
 * the starter, `manager-of` names the starter's manager, and `field` reads the
 * principal at its key in the instance data. The result is undefined when the
 * field holds no principal.
 */
function namedPrincipal(target: Target, context: TargetContext): string | undefined {
  if ('user' in target) return target.user
  if ('group' in target) return target.group
  if ('team' in target) return target.team
  if ('starter' in target) return context.starter
  if ('manager-of' in target) return context.managerOf
  return fieldPrincipal(context, target.field)
}

/** The principal at a field key, when the instance data holds a string (AS-1). */
function fieldPrincipal(context: TargetContext, key: string): string | undefined {
  const value = context.data[key]
  return typeof value === 'string' ? value : undefined
}

/** A target in its file form, for a timeline reason (AS-1, A8). */
function describeTarget(target: Target): string {
  if ('user' in target) return `user:${target.user}`
  if ('group' in target) return `group:${target.group}`
  if ('team' in target) return `team:${target.team}`
  if ('field' in target) return `field:${target.field}`
  if ('starter' in target) return `starter:${target.starter}`
  return `manager-of:${target['manager-of']}`
}
