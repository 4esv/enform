import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import { authorize, type Grant } from '../engine/authorize.js'
import { addGrant, grantsOf } from '../engine/grants.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import { teamsOf } from '../engine/teams.js'

// Issue #256, AC-2, AS-6, I4, I8, I14, S02, S08: a grant revoke and the team
// operations are attributed configuration operations that the shared resolver
// serves. A revoke removes the named scopes of a principal on a resource and
// nothing else, the grant projection folds both, and a team is created and
// maintained by a principal with `org.teams` on `org` through the same write
// path as every other change.

const DANA = 'user:dana'
const PRIYA = 'user:priya'
const JORDAN = 'user:jordan'
const FLOW = 'flow:course-overload'
const REGISTRAR = 'flow:course-overload/step:registrar'

type Resolver = (
  context: {
    log: State['log']
    principal: { id: string; groups: readonly string[] }
    grants: readonly Grant[]
    resolver: () => never[]
    now: () => number
  },
  body: Record<string, unknown>
) => { operation: Operation } | { status: number; error: string }

async function resolverModule(): Promise<{ resolveClientOperation: Resolver }> {
  return (await import('../server/intents.js')) as unknown as { resolveClientOperation: Resolver }
}

function deps(id: string): OperationDeps {
  return { clock: () => 1, ids: () => id }
}

/** Dana holds org.grants and org.teams, as the first administrator does. */
const dana: readonly Grant[] = [
  { principal: DANA, scopes: ['org.grants', 'org.teams'], resource: 'org' },
]

function context(state: State, actor: string, grants: readonly Grant[]) {
  return {
    log: state.log,
    principal: { id: actor, groups: [] },
    grants,
    resolver: () => [],
    now: () => 1,
  }
}

test('#256 AC-2 a revoke removes the named scopes and the projection folds it', async () => {
  const { resolveClientOperation } = await resolverModule()
  let state = emptyState
  state = apply(
    addGrant(
      {
        principal: JORDAN,
        scopes: ['step.outcome:send_back', 'step.outcome:approve'],
        resource: REGISTRAR,
      },
      DANA,
      deps('g-1')
    ),
    state
  )
  state = apply(
    addGrant({ principal: JORDAN, scopes: ['flow.read'], resource: FLOW }, DANA, deps('g-2')),
    state
  )

  // Priya holds no grant scope: her revoke is refused (I8).
  const refused = resolveClientOperation(context(state, PRIYA, []), {
    id: 'r-priya',
    type: 'config.grant.changed@1',
    at: 2,
    actor: PRIYA,
    payload: {
      principal: JORDAN,
      scopes: ['step.outcome:approve'],
      resource: REGISTRAR,
      change: 'revoked',
    },
  })
  expect('status' in refused && refused.status).toBe(403)

  // Dana revokes approve on the registrar step: send back and the flow read
  // stay (AC-2), and the change is attributed (I14).
  const revoked = resolveClientOperation(context(state, DANA, dana), {
    id: 'r-dana',
    type: 'config.grant.changed@1',
    at: 2,
    actor: DANA,
    payload: {
      principal: JORDAN,
      scopes: ['step.outcome:approve'],
      resource: REGISTRAR,
      change: 'revoked',
    },
  })
  if (!('operation' in revoked)) throw new Error(revoked.error)
  expect(revoked.operation.actor).toBe(DANA)
  expect(revoked.operation.payload).toEqual({
    principal: JORDAN,
    scopes: ['step.outcome:approve'],
    resource: REGISTRAR,
    change: 'revoked',
  })
  state = apply(revoked.operation, state)
  const held = grantsOf(state.log).filter((grant) => grant.principal === JORDAN)
  expect(held).toEqual([
    { principal: JORDAN, scopes: ['step.outcome:send_back'], resource: REGISTRAR },
    { principal: JORDAN, scopes: ['flow.read'], resource: FLOW },
  ])
  expect(authorize(held, 'step.outcome:approve', REGISTRAR)).toBe(false)
  expect(authorize(held, 'step.outcome:send_back', REGISTRAR)).toBe(true)
  // The original grant event stays on the log (I4).
  expect(state.log.filter((event) => event.type === 'config.grant.changed@1')).toHaveLength(3)
})

test('#256 AS-6 a team is created and maintained through the write path by org.teams', async () => {
  const { resolveClientOperation } = await resolverModule()
  let state = emptyState
  const post = (
    actor: string,
    grants: readonly Grant[],
    id: string,
    payload: Record<string, unknown>
  ) =>
    resolveClientOperation(context(state, actor, grants), {
      id,
      type: 'config.team.changed@1',
      at: 3,
      actor,
      payload,
    })

  // Priya lacks org.teams: refused (AS-6, I8).
  const refused = post(PRIYA, [], 't-0', { team: 'registrar-office', change: 'created' })
  expect('status' in refused && refused.status).toBe(403)

  const created = post(DANA, dana, 't-1', { team: 'registrar-office', change: 'created' })
  if (!('operation' in created)) throw new Error(created.error)
  state = apply(created.operation, state)
  const added = post(DANA, dana, 't-2', {
    team: 'registrar-office',
    change: 'member-added',
    member: JORDAN,
  })
  if (!('operation' in added)) throw new Error(added.error)
  state = apply(added.operation, state)
  expect(teamsOf(state.log)).toEqual([{ name: 'registrar-office', members: [JORDAN] }])

  // An unknown team, a membership change without a member and a malformed
  // change are refused before anything is appended.
  expect(
    'status' in post(DANA, dana, 't-3', { team: 'nope', change: 'member-added', member: JORDAN })
  ).toBe(true)
  expect(
    'status' in post(DANA, dana, 't-4', { team: 'registrar-office', change: 'member-added' })
  ).toBe(true)
  expect('status' in post(DANA, dana, 't-5', { team: 'registrar-office', change: 'renamed' })).toBe(
    true
  )

  const removed = post(DANA, dana, 't-6', {
    team: 'registrar-office',
    change: 'member-removed',
    member: JORDAN,
  })
  if (!('operation' in removed)) throw new Error(removed.error)
  state = apply(removed.operation, state)
  expect(teamsOf(state.log)).toEqual([{ name: 'registrar-office', members: [] }])
  expect(state.log.every((event) => event.actor === DANA)).toBe(true)
})
