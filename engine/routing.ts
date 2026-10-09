// Issue #16, I10, AS-1, AS-4, AS-5, A4, A8: target resolution and Unroutable routing.
//
// I10: if the targets of a task resolve to nobody, the task goes to the
// Unroutable queue and the flow owner gets an alert. The engine never drops a
// task silently. AS-4: groups and teams resolve live, and dynamic targets
// resolve once; the instance records both. Routing is a pure function of the
// step, the resolver and the flow owner: it reads no clock, no random source
// and no directory of its own (I6), so the same inputs give the same route.

import type { FlowStep, Target } from './definition.js'
import type { Assignee } from './instance.js'
import type { ActorId } from './operation.js'
import type { OutboxEntry } from './outbox.js'

/**
 * Resolve one target to the principal IDs that it names (I10, AS-4). The
 * caller injects it: a group or a team resolves live through the directory,
 * and a dynamic target resolves once. It returns an empty list when the target
 * resolves to nobody.
 */
export type TargetResolver = (target: Target) => readonly string[]

/**
 * The queue that holds a task whose targets resolve to nobody (I10, AS-5). It
 * is a marker, not a principal: it names the destination, so that the task is
 * never dropped.
 */
export const UNROUTABLE_QUEUE = 'queue:unroutable'

/**
 * The connector operation that alerts the flow owner about an unroutable task
 * (I10, SE-2). It is the `unroutable` event type of SE-2.
 */
export const UNROUTABLE_ALERT = 'send-unroutable'

/** The connector that carries an alert (SE-1, SE-2). */
export const ALERT_CONNECTOR = 'connector-smtp'

/**
 * The route of one step's task (I10, AS-4). It carries the resolved assignees
 * with their membership snapshots, or, when the targets resolve to nobody, the
 * Unroutable queue and the alert that the flow owner receives.
 */
export type RouteResult = {
  /** The step whose task this is (WF-1). */
  readonly step: string
  /** The resolved assignees with their membership snapshots (I13). It is empty when the task is unroutable (I10). */
  readonly assignees: readonly Assignee[]
  /** The Unroutable queue when no target resolved (I10, AS-5); absent otherwise. */
  readonly queue?: string
  /** The alert to the flow owner when the task is unroutable (I10, SE-2); absent otherwise. */
  readonly alert?: OutboxEntry
}

/**
 * Resolve the targets of a step to assignees (AS-4, I13). Every target yields
 * one assignee with the members that the resolver returns, so a target that
 * resolves to nobody carries an empty membership snapshot (I13, I10). The
 * resolution is deterministic (I6): it depends on the step and the resolver
 * alone.
 */
export function resolveAssignees(step: FlowStep, resolve: TargetResolver): readonly Assignee[] {
  return step.targets.map((target) => ({ step: step.key, target, members: resolve(target) }))
}

/**
 * Route the task of a step (I10, AS-4). When at least one target resolves to a
 * member the task routes to those assignees and raises no alert. When every
 * target resolves to nobody the task goes to the Unroutable queue and the flow
 * owner gets an alert, so the task is never dropped. The function is pure and
 * deterministic (I6).
 */
export function route(step: FlowStep, resolve: TargetResolver, owner: ActorId): RouteResult {
  const assignees = resolveAssignees(step, resolve)
  const routed = assignees.some((assignee) => assignee.members.length > 0)
  if (routed) return { step: step.key, assignees }
  return { step: step.key, assignees, queue: UNROUTABLE_QUEUE, alert: alertOwner(step, owner) }
}

/** The alert that the flow owner receives for an unroutable task (I10, SE-2). */
function alertOwner(step: FlowStep, owner: ActorId): OutboxEntry {
  return {
    operation: UNROUTABLE_ALERT,
    target: ALERT_CONNECTOR,
    payload: { to: owner, step: step.key },
  }
}
