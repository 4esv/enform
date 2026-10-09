import { expect, test } from 'vitest'
import { contentHash, createInstance } from '../../engine/instance.js'
import {
  createResolver,
  refreshAssignees,
  resolveTarget,
  unroutableReason,
} from '../../engine/resolve.js'
import { ALERT_CONNECTOR, route, UNROUTABLE_ALERT, UNROUTABLE_QUEUE } from '../../engine/routing.js'
import {
  ADVISOR_FIELD,
  ANA,
  definition,
  deprovisioned,
  directory,
  INITIAL_DIRECTORY,
  OWNER,
  PROVISIONED_ADVISOR,
  provisioned,
  REGISTRAR_MEMBERS,
  REGISTRAR_TEAM,
  STARTER,
  versionHash,
} from './scenario.js'

// Issue #45: route each task to real, current people (S08). A dynamic target
// resolves once, at creation: when the advisor field names a deprovisioned
// user the task has no recipient and goes to the Unroutable queue, with an
// alert to the flow owner and a reason (I10, AS-5). A group or a team resolves
// live: when Ana joins registrar-office while the task is open, a
// re-resolution shows the task to her with no new publication (AS-4). Each
// instance records the resolved assignees and the membership snapshot (I13).
// The path is deterministic (I6).
//
// SCAFFOLD (issue #45, commit 1): the resolver is stubbed, so this check is
// expected to fail until the change that closes the issue unmarks it.

test.fails('#45 a task routes to the current people or to Unroutable (S08)', () => {
  const dir = directory(INITIAL_DIRECTORY)
  const advisorStep = definition.steps[0]
  const registrarStep = definition.steps[1]

  // (a) AS-5: the advisor field names a deprovisioned user, so the advisor
  // task resolves to nobody. It goes to the Unroutable queue, Priya gets the
  // alert, and the reason names the step and the target (I10).
  const unrouted = route(advisorStep, createResolver(dir.membership, deprovisioned), OWNER)
  expect(unrouted.assignees).toEqual([
    { step: 'advisor', target: { field: ADVISOR_FIELD }, members: [] },
  ])
  expect(unrouted.queue).toBe(UNROUTABLE_QUEUE)
  expect(unrouted.alert).toEqual({
    operation: UNROUTABLE_ALERT,
    target: ALERT_CONNECTOR,
    payload: { to: OWNER, step: 'advisor' },
  })
  expect(unroutableReason(advisorStep, unrouted.assignees)).toBe(
    'step advisor: no target resolved to a current principal (field:advisor)'
  )

  // The same field target resolves while the account is provisioned, so the
  // unroutable result is about the missing principal, not the target kind.
  const routed = route(advisorStep, createResolver(dir.membership, provisioned), OWNER)
  expect(routed.assignees).toEqual([
    { step: 'advisor', target: { field: ADVISOR_FIELD }, members: [PROVISIONED_ADVISOR] },
  ])
  expect(routed.queue).toBeUndefined()
  expect(routed.alert).toBeUndefined()

  // (b) AS-4: the team target resolves live. Lee and Jordan hold the registrar
  // task now. Ana joins while the task is open, and a re-resolution includes
  // her with no publication: the definition and its version are unchanged.
  const before = route(registrarStep, createResolver(dir.membership, deprovisioned), OWNER)
  expect(before.assignees).toEqual([
    { step: 'registrar', target: { team: REGISTRAR_TEAM }, members: REGISTRAR_MEMBERS },
  ])
  dir.join(REGISTRAR_TEAM, ANA)
  const after = refreshAssignees(before.assignees, dir.membership)
  expect(after).toEqual([
    { step: 'registrar', target: { team: REGISTRAR_TEAM }, members: [...REGISTRAR_MEMBERS, ANA] },
  ])
  expect(contentHash(definition)).toBe(versionHash)

  // (c) AS-4, I13: a dynamic target resolves once. A re-resolution keeps the
  // members that the instance recorded, even after the principal leaves.
  const recorded = [
    { step: 'advisor', target: { field: ADVISOR_FIELD }, members: [PROVISIONED_ADVISOR] },
  ] as const
  const shrunk = directory({ ...INITIAL_DIRECTORY, [PROVISIONED_ADVISOR]: [] })
  expect(refreshAssignees(recorded, shrunk.membership)).toEqual(recorded)

  // (d) I13: the instance records the resolved assignees and the snapshot.
  const instance = createInstance(definition, before.assignees)
  expect(instance.definitionVersion).toBe(versionHash)
  expect(instance.assignees).toEqual(before.assignees)

  // (e) AS-1: all six target kinds resolve. A user, a group and a team name a
  // directory principal; a field, the starter and the starter's manager name
  // one through the instance.
  expect(resolveTarget({ user: PROVISIONED_ADVISOR }, dir.membership, provisioned)).toEqual([
    PROVISIONED_ADVISOR,
  ])
  expect(resolveTarget({ group: 'CS-Chairs' }, dir.membership, provisioned)).toEqual(['user:lin'])
  expect(resolveTarget({ team: REGISTRAR_TEAM }, dir.membership, provisioned)).toEqual([
    ...REGISTRAR_MEMBERS,
    ANA,
  ])
  expect(resolveTarget({ field: ADVISOR_FIELD }, dir.membership, provisioned)).toEqual([
    PROVISIONED_ADVISOR,
  ])
  expect(resolveTarget({ starter: 'starter' }, dir.membership, provisioned)).toEqual([STARTER])
  expect(resolveTarget({ 'manager-of': 'starter' }, dir.membership, provisioned)).toEqual([OWNER])

  // (f) I6: the same inputs give the same route.
  const twice = route(advisorStep, createResolver(dir.membership, deprovisioned), OWNER)
  expect(twice).toEqual(unrouted)
})
