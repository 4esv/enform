import { expect, test } from 'vitest'
import { apply, emptyState, rebuild, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { addGrant, grantsOf } from '../engine/grants.js'
import type { OperationDeps } from '../engine/operation.js'
import { resolveTarget, type TargetContext } from '../engine/resolve.js'
import {
  addTeamMember,
  createTeam,
  removeTeamMember,
  TEAM_CHANGE_TYPE,
  teamMembership,
  teamsOf,
} from '../engine/teams.js'

// Issue #81, AS-6, AS-4, ID-4, AC-1, I4, I6, I8, I14, A1: a user with the
// scope `org.teams` creates and maintains teams. A team is a named membership
// group (ID-4): it holds user and group principals. Every change is one
// attributed `config.team.changed@1` operation on the append-only log (I4,
// I14), and the team set is a projection of that log. A task targeted at a
// team resolves live to the members that the team holds now (AS-4). Only the
// engine evaluates the scope, so a user without `org.teams` is refused (AC-1,
// I8).

/** The time of the operations (I6): the clock is injected. */
const AT = 1_700_000_000_000

/** The injected sources of the path (I6): a fixed clock and sequential IDs. */
function sources(): OperationDeps {
  let next = 0
  return {
    clock: () => AT,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

/** The user who holds `org.teams` on `org` and maintains the teams (AS-6). */
const DANA = 'user:dana'

/** A user without `org.teams`: he holds `org.grants` instead (AS-6, AC-1). */
const SAM = 'user:sam'

/** The team that the registrar task is targeted at (AS-4). */
const TEAM = 'registrar-office'

/** The two members of the team: a user and a directory group (ID-4). */
const LEE = 'user:lee'
const STAFF = 'group:registrar-staff'

/** The grants that one principal holds, read back from the log (AC-1, grants.ts). */
function grantsWith(principal: string, scope: string, deps: OperationDeps): readonly Grant[] {
  const state = apply(
    addGrant({ principal, scopes: [scope], resource: 'org' }, principal, deps),
    emptyState
  )
  return grantsOf(state.log)
}

test.fails('#81 AS-6 users with org.teams create and maintain teams', () => {
  const deps = sources()

  // AC-1: a grant is `(principal, scope, resource)`. Dana holds `org.teams` on
  // `org`; Sam holds `org.grants`, so the team scope is not his (AS-6).
  const danaGrants = grantsWith(DANA, 'org.teams', deps)
  const samGrants = grantsWith(SAM, 'org.grants', deps)
  const noGrants: readonly Grant[] = []

  // (a) Dana creates the team, adds a user and a group, then removes the user.
  // Each change is one attributed `config.team.changed@1` operation (I14), and
  // the team set is a projection of the append-only log (I4).
  let state: State = emptyState
  const created = createTeam(TEAM, DANA, deps, danaGrants)
  expect(created.team).toEqual({ name: TEAM, members: [] })
  expect(created.operation.type).toBe(TEAM_CHANGE_TYPE)
  expect(created.operation.actor).toBe(DANA)
  state = apply(created.operation, state)

  const withLee = addTeamMember(created.team, LEE, DANA, deps, danaGrants)
  expect(withLee.team).toEqual({ name: TEAM, members: [LEE] })
  state = apply(withLee.operation, state)

  const withStaff = addTeamMember(withLee.team, STAFF, DANA, deps, danaGrants)
  expect(withStaff.team).toEqual({ name: TEAM, members: [LEE, STAFF] })
  state = apply(withStaff.operation, state)

  // AS-4: the task targeted at the team resolves to the members that the team
  // holds now: the user and the group.
  const context: TargetContext = { data: {}, starter: SAM, managerOf: SAM }
  expect(resolveTarget({ team: TEAM }, teamMembership(state.log), context)).toEqual([LEE, STAFF])

  const withoutLee = removeTeamMember(withStaff.team, LEE, DANA, deps, danaGrants)
  expect(withoutLee.team).toEqual({ name: TEAM, members: [STAFF] })
  state = apply(withoutLee.operation, state)

  // (b) AS-4 after the membership change: the same target now resolves to the
  // group only, with no new publication. The membership is a pure function of
  // the log (I4, I6), so a rebuild reproduces it.
  expect(resolveTarget({ team: TEAM }, teamMembership(state.log), context)).toEqual([STAFF])
  expect(teamsOf(state.log)).toEqual([{ name: TEAM, members: [STAFF] }])
  expect(teamsOf(rebuild(state.log).log)).toEqual([{ name: TEAM, members: [STAFF] }])

  // The log holds one attributed, versioned operation per change (I14), and it
  // is append-only: four changes, four events.
  expect(state.log).toHaveLength(4)
  for (const event of state.log) {
    expect(event.type).toBe(TEAM_CHANGE_TYPE)
    expect(event.actor).toBe(DANA)
  }

  // A member that the team already holds is not added twice (ID-4, I1).
  expect(addTeamMember(withLee.team, LEE, DANA, sources(), danaGrants).team).toEqual(withLee.team)

  // I6: the same inputs and the same injected sources give the same change.
  expect(createTeam(TEAM, DANA, sources(), danaGrants)).toEqual(
    createTeam(TEAM, DANA, sources(), danaGrants)
  )

  // (c) A user without `org.teams` on `org` is refused (AS-6, AC-1, I8): Sam's
  // `org.grants` grant does not authorize a team change, and neither does no
  // grant at all.
  for (const grants of [samGrants, noGrants]) {
    expect(() => createTeam(TEAM, SAM, deps, grants)).toThrow(/org\.teams/)
    expect(() => addTeamMember(created.team, LEE, SAM, deps, grants)).toThrow(/org\.teams/)
    expect(() => removeTeamMember(created.team, LEE, SAM, deps, grants)).toThrow(/org\.teams/)
  }
})
