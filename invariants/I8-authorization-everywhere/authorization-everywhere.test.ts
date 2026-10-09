// Issue #14, I8, AC-1, AC-4, A3, A9: the authorization oracle.
//
// I8: the server authorizes every read and write, and a subscriber never
// receives an event that it cannot see. AC-1: authorization is a pure function
// of grants, scope and resource, and only the engine evaluates it. AC-4: a
// `step.outcome:<name>` scope controls which outcomes a person can choose. The
// oracle below states that over the grants of one principal, so a story run can
// call it for the principal that acts in that run (MVP.md 11.4).
//
// The first two checks are expected to fail until commit 2 implements the full
// model, so `test.fails` marks them for now (CONTRIBUTING.md, AGENTS.md).

import { expect, test } from 'vitest'
import { authorize, type Grant } from '../../engine/authorize.js'
import type { ActorId } from '../../engine/operation.js'

/** The flow of every story (STORIES.md, the example flow). */
const FLOW = 'flow:course-overload'

/** Two steps under that flow, from the S02 grants. */
const CHAIR = 'flow:course-overload/step:chair'
const REGISTRAR = 'flow:course-overload/step:registrar'

/**
 * The grants of S02, as the engine stores them (STORIES.md, S02; MVP.md 5.6).
 * Presets such as "Approver" expand to scopes before the grant is recorded
 * (AC-3), so this list holds only principals, scopes and resources.
 */
const GRANTS: readonly Grant[] = [
  { principal: 'group:All-Students', scopes: ['instance.start'], resource: FLOW },
  {
    principal: 'user:lee',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: REGISTRAR,
  },
  { principal: 'user:jordan', scopes: ['step.outcome:send_back'], resource: REGISTRAR },
  {
    principal: 'group:CS-Chairs',
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: CHAIR,
  },
  {
    principal: 'user:priya',
    scopes: ['flow.edit', 'flow.dryrun', 'instance.read', 'instance.timeline', 'task.reassign'],
    resource: FLOW,
  },
  {
    principal: 'user:dana',
    scopes: ['org.grants', 'org.connectors', 'org.teams', 'org.impersonate'],
    resource: 'org',
  },
]

/**
 * The grants that one principal holds. AC-1 authorizes against those grants:
 * the caller passes the principal's own grants and those of its groups and
 * teams, and the function reads nothing else.
 */
function grantsOf(principal: ActorId, grants: readonly Grant[] = GRANTS): Grant[] {
  return grants.filter((grant) => grant.principal === principal)
}

/**
 * The I8 oracle. Authorize one principal's actions from its grants alone
 * (AC-1, I8). It states three rules: a principal without the grant is denied,
 * a grant on a flow authorizes every step under it (MVP.md 5.6), and a
 * `step.outcome:<name>` scope authorizes exactly that outcome and no other
 * (AC-4). A story run can call it for the principal that acts in its run.
 */
function assertAuthorized(authorizeFn: typeof authorize = authorize): void {
  // Jordan holds only `step.outcome:send_back` on the registrar step. AC-4:
  // that scope authorizes Send back and no other outcome, so approve is denied.
  expect(authorizeFn(grantsOf('user:jordan'), 'step.outcome:send_back', REGISTRAR)).toBe(true)
  expect(authorizeFn(grantsOf('user:jordan'), 'step.outcome:approve', REGISTRAR)).toBe(false)

  // A grant on a flow applies to all of its steps (MVP.md 5.6): Priya reads
  // every instance of the flow, at any step.
  expect(authorizeFn(grantsOf('user:priya'), 'instance.read', FLOW)).toBe(true)
  expect(authorizeFn(grantsOf('user:priya'), 'instance.read', REGISTRAR)).toBe(true)
  expect(authorizeFn(grantsOf('user:priya'), 'instance.read', CHAIR)).toBe(true)

  // A principal that holds no matching grant is denied (I8).
  expect(authorizeFn(grantsOf('user:jordan'), 'instance.read', FLOW)).toBe(false)
  expect(authorizeFn(grantsOf('group:All-Students'), 'instance.read', FLOW)).toBe(false)

  // An org scope acts on the org resource, not on a flow.
  expect(authorizeFn(grantsOf('user:dana'), 'org.grants', 'org')).toBe(true)
  expect(authorizeFn(grantsOf('user:dana'), 'org.grants', FLOW)).toBe(false)
}

test.fails('#14 a principal sees only the actions that its grants allow (I8)', () => {
  expect(grantsOf('user:jordan')).toHaveLength(1)
  assertAuthorized()
})

test.fails('#14 a resource wildcard covers a flow and every step under it (I8)', () => {
  const held: readonly Grant[] = [
    { principal: 'user:ops', scopes: ['instance.read'], resource: 'flow:*' },
  ]
  expect(authorize(held, 'instance.read', FLOW)).toBe(true)
  expect(authorize(held, 'instance.read', REGISTRAR)).toBe(true)
  expect(authorize(held, 'instance.read', 'org')).toBe(false)
})

/**
 * The deliberate violation of the check above: a `step.outcome:<name>` scope
 * that over-grants. It matches the scope by its prefix and ignores the
 * resource, so Jordan could approve at the registrar step and CS-Chairs would
 * cover the registrar step too. The oracle must fail on it, and `test.fails`
 * asserts that failure.
 */
function authorizeByOutcomePrefix(grants: readonly Grant[], scope: string): boolean {
  return grants.some((grant) =>
    grant.scopes.some(
      (held) => scope.startsWith('step.outcome:') && held.startsWith('step.outcome:')
    )
  )
}

test.fails('#14 the oracle fails when a step outcome scope over-grants (I8)', () => {
  assertAuthorized(authorizeByOutcomePrefix)
})
