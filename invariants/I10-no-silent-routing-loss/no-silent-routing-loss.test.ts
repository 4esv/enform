// Issue #16, I10, AS-1, AS-4, AS-5, A4, A8: the no-silent-routing-loss oracle.
//
// I10: if the targets of a task resolve to nobody, the task goes to the
// Unroutable queue and the flow owner gets an alert. The engine never drops a
// task silently. The oracle below states that as a check over one step's
// route, so a story run can call it for the step that its run routed
// (MVP.md 11.4).
//
// Scaffolding for #16: the first check is marked as expected to fail, because
// the engine functions are stubs until the second commit implements them. The
// deliberate violation below already fails the oracle, and it stays marked.

import { expect, test } from 'vitest'
import type { FlowStep } from '../../engine/definition.js'
import type { ActorId } from '../../engine/operation.js'
import {
  ALERT_CONNECTOR,
  type RouteResult,
  route,
  type TargetResolver,
  UNROUTABLE_ALERT,
  UNROUTABLE_QUEUE,
} from '../../engine/routing.js'

/** The flow owner: a principal with `task.reassign` on the flow (MVP.md 3, I10). */
const OWNER = 'user:priya'

/** The step of the story flow whose task the checks route (WF-1). */
const STEP: FlowStep = {
  key: 'chair',
  targets: [{ group: 'CS-Chairs' }],
  outcomes: ['approve', 'send_back'],
}

/** The members that the group `CS-Chairs` resolves to at routing time (AS-4). */
const CHAIRS = ['person-ana', 'person-bao']

/** A resolver for a directory in which the group holds its members (AS-4). */
function resolveMembers(): readonly string[] {
  return CHAIRS
}

/** A resolver for a directory in which every target resolves to nobody (I10). */
function resolveNobody(): readonly string[] {
  return []
}

/**
 * The I10 oracle. Check one route: a task whose targets resolve to at least
 * one member routes to those assignees and never enters the Unroutable queue;
 * a task whose targets resolve to nobody goes to the Unroutable queue and
 * alerts the flow owner, so it is never dropped (I10, AS-5). A story run can
 * call it for the step that its run routed (MVP.md 11.4).
 */
function assertNoSilentRoutingLoss(
  step: FlowStep,
  resolve: TargetResolver,
  owner: ActorId,
  routeFn: (step: FlowStep, resolve: TargetResolver, owner: ActorId) => RouteResult = route
): void {
  const result = routeFn(step, resolve, owner)
  const routed = result.assignees.some((assignee) => assignee.members.length > 0)

  if (routed) {
    expect(result.queue, 'a resolved task enters the Unroutable queue').toBeUndefined()
    expect(result.alert, 'a resolved task raises an unroutable alert').toBeUndefined()
    return
  }

  expect(result.queue, 'an empty resolution does not reach the Unroutable queue').toBe(
    UNROUTABLE_QUEUE
  )
  expect(result.alert, 'an unroutable task raises no alert').toBeDefined()
  expect(result.alert?.payload.to, 'the alert does not reach the flow owner').toBe(owner)
}

test.fails('#16 a task routes to its assignees or to Unroutable, never nowhere (I10)', () => {
  const unroutable = route(STEP, resolveNobody, OWNER)
  expect(unroutable.assignees.flatMap((assignee) => assignee.members)).toEqual([])
  expect(unroutable.queue).toBe(UNROUTABLE_QUEUE)
  expect(unroutable.alert).toEqual({
    operation: UNROUTABLE_ALERT,
    target: ALERT_CONNECTOR,
    payload: { to: OWNER, step: STEP.key },
  })
  assertNoSilentRoutingLoss(STEP, resolveNobody, OWNER)

  const routed = route(STEP, resolveMembers, OWNER)
  expect(routed.assignees.flatMap((assignee) => assignee.members)).toEqual(CHAIRS)
  expect(routed.queue).toBeUndefined()
  expect(routed.alert).toBeUndefined()
  assertNoSilentRoutingLoss(STEP, resolveMembers, OWNER)
})

/**
 * The deliberate violation of the check above: a router that drops a task
 * whose targets resolve to nobody. It returns no assignee and no Unroutable
 * queue, so the task is lost (I10). The oracle must fail on it, and
 * `test.fails` asserts that failure.
 */
function dropUnroutable(step: FlowStep, _resolve: TargetResolver, _owner: ActorId): RouteResult {
  return { step: step.key, assignees: [] }
}

test.fails('#16 the oracle fails when a router drops an unroutable task (I10)', () => {
  assertNoSilentRoutingLoss(STEP, resolveNobody, OWNER, dropUnroutable)
})
