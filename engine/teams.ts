// Issue #81, AS-6, AS-4, ID-4, AC-1, I4, I6, I8, I14, A1: teams are named
// membership groups that a user with the scope `org.teams` creates and
// maintains.
//
// AS-6: a user with the scope `org.teams` on the resource `org` creates and
// maintains teams. A team is a named membership group (ID-4): it holds user
// and group principals, and the engine reads those members on every
// resolution, so a task targeted at a team resolves to the members that the
// team holds now (AS-4). Every change is one attributed `config.team.changed@1`
// operation on the append-only log (I4, I14), and the team set is a projection
// of that log, like the grants (grants.ts).
//
// The team model is not read yet: a team change records no payload and a team
// holds no member, so `teamsOf` returns nobody and `teamMembership` resolves
// to nobody. The check in tools/teams.test.ts is marked as expected to fail
// until the model lands (#81, AS-6).

import type { Grant } from './authorize.js'
import { configType } from './config.js'
import {
  type ActorId,
  createOperation,
  type Log,
  type Operation,
  type OperationDeps,
} from './operation.js'
import type { Membership } from './resolve.js'

/** The versioned event type of one team change (AS-6, I14). */
export const TEAM_CHANGE_TYPE = configType('team')

/** One team: its name (its principal ID) and the members that it holds now (ID-4, AS-4). */
export type Team = {
  readonly name: string
  readonly members: readonly string[]
}

/** The result of one team change: the team after the change and the operation that recorded it (I14). */
export type TeamChange = {
  readonly team: Team
  readonly operation: Operation
}

/**
 * Issue #81 (AS-6): the team model is not read yet, so a team holds no member
 * and its creation records no payload.
 */
export function createTeam(
  _name: string,
  actor: ActorId,
  deps: OperationDeps,
  _grants: readonly Grant[]
): TeamChange {
  return {
    team: { name: '', members: [] },
    operation: createOperation(TEAM_CHANGE_TYPE, {}, deps, actor),
  }
}

/**
 * Issue #81 (AS-6): the team model is not read yet, so no member is added and
 * the change records no payload.
 */
export function addTeamMember(
  _team: Team,
  _member: string,
  actor: ActorId,
  deps: OperationDeps,
  _grants: readonly Grant[]
): TeamChange {
  return {
    team: { name: '', members: [] },
    operation: createOperation(TEAM_CHANGE_TYPE, {}, deps, actor),
  }
}

/**
 * Issue #81 (AS-6): the team model is not read yet, so no member is removed
 * and the change records no payload.
 */
export function removeTeamMember(
  _team: Team,
  _member: string,
  actor: ActorId,
  deps: OperationDeps,
  _grants: readonly Grant[]
): TeamChange {
  return {
    team: { name: '', members: [] },
    operation: createOperation(TEAM_CHANGE_TYPE, {}, deps, actor),
  }
}

/** Issue #81 (AS-6): the team model is not read yet, so the log projects no team. */
export function teamsOf(_log: Log): readonly Team[] {
  return []
}

/** Issue #81 (AS-6): the team model is not read yet, so no team resolves to a member. */
export function teamMembership(_log: Log): Membership {
  return () => []
}
