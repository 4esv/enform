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
// of that log, like the grants (grants.ts): a rebuild reproduces it. The
// engine is the only place that evaluates the scope (AC-1, I8), and every
// function is pure and deterministic (I6): it reads no clock, no random source
// and no other state.

import { authorize, type Grant } from './authorize.js'
import { configOperation, configType } from './config.js'
import type { ActorId, Log, Operation, OperationDeps } from './operation.js'
import type { Membership } from './resolve.js'

/** The versioned event type of one team change (AS-6, I14). */
export const TEAM_CHANGE_TYPE = configType('team')

/** The scope that creating or maintaining a team requires on `org` (AS-6, AC-1). */
const TEAM_SCOPE = 'org.teams'

/** The kind of change that one team operation records (AS-6, I14). */
type TeamChangeKind = 'created' | 'member-added' | 'member-removed'

/** One team: its name (its principal ID) and the members that it holds now (ID-4, AS-4). */
export type Team = {
  /** The team name: the principal ID that a team target names (ID-4). */
  readonly name: string
  /** The members that the team holds now: user and group IDs, in the order they joined (ID-4). */
  readonly members: readonly string[]
}

/** The result of one team change: the team after the change and the operation that recorded it (I14). */
export type TeamChange = {
  readonly team: Team
  readonly operation: Operation
}

/** The payload of one team change (AS-6, I14). */
type TeamChangePayload = {
  readonly team: string
  readonly change: TeamChangeKind
  readonly member?: string
}

/**
 * Create a team with no members (AS-6, I14). One `config.team.changed@1`
 * operation records the creation, attributed to the actor. The engine refuses
 * the change unless the actor holds the scope `org.teams` on the resource
 * `org` (AC-1, I8).
 */
export function createTeam(
  name: string,
  actor: ActorId,
  deps: OperationDeps,
  grants: readonly Grant[]
): TeamChange {
  assertTeamsAllowed(actor, grants)
  const operation = configOperation(
    { kind: 'team', actor, payload: { team: name, change: 'created' } },
    deps
  )
  return { team: { name, members: [] }, operation }
}

/**
 * Add one member, a user or a group, to a team (AS-6, I14). The operation is
 * attributed and the log records it (I14). A member that the team already
 * holds is not added twice, so the team that the function returns and the
 * projection agree (ID-4, I1). The function authorizes the change exactly as
 * `createTeam` does (AC-1, I8).
 */
export function addTeamMember(
  team: Team,
  member: string,
  actor: ActorId,
  deps: OperationDeps,
  grants: readonly Grant[]
): TeamChange {
  assertTeamsAllowed(actor, grants)
  const operation = configOperation(
    { kind: 'team', actor, payload: { team: team.name, change: 'member-added', member } },
    deps
  )
  const changed: Team = team.members.includes(member)
    ? team
    : { ...team, members: [...team.members, member] }
  return { team: changed, operation }
}

/**
 * Remove one member from a team (AS-6, I14). The operation is attributed and
 * the log records it (I14). The member that the team no longer holds is gone
 * from the team that the function returns and from the projection (ID-4). The
 * function authorizes the change exactly as `createTeam` does (AC-1, I8).
 */
export function removeTeamMember(
  team: Team,
  member: string,
  actor: ActorId,
  deps: OperationDeps,
  grants: readonly Grant[]
): TeamChange {
  assertTeamsAllowed(actor, grants)
  const operation = configOperation(
    { kind: 'team', actor, payload: { team: team.name, change: 'member-removed', member } },
    deps
  )
  return { team: { ...team, members: team.members.filter((held) => held !== member) }, operation }
}

/**
 * The teams that the log records, in creation order (I4, AS-6). The log is the
 * single source of truth, so the team set is a projection of it and never a
 * second store: a rebuild from the log reproduces it (I4). A creation opens a
 * team, a member change folds into it, and a change that names an unknown team
 * or a missing member throws. The function is a pure function of the log (I6).
 */
export function teamsOf(log: Log): readonly Team[] {
  const teams = new Map<string, readonly string[]>()
  for (const event of log) {
    if (event.type !== TEAM_CHANGE_TYPE) continue
    const change = readTeamChange(event.payload)
    if (change.change === 'created') {
      if (!teams.has(change.team)) teams.set(change.team, [])
      continue
    }
    const members = teams.get(change.team)
    if (members === undefined) {
      throw new Error(`teams: the change names the unknown team ${change.team}`)
    }
    if (change.member === undefined) {
      throw new Error('teams: a membership change must name a member')
    }
    if (change.change === 'member-added') {
      if (!members.includes(change.member)) teams.set(change.team, [...members, change.member])
    } else {
      teams.set(
        change.team,
        members.filter((held) => held !== change.member)
      )
    }
  }
  return [...teams].map(([name, members]) => ({ name, members }))
}

/**
 * The membership that a task resolves against (AS-4, ID-4). It reads the teams
 * from the log, so a task targeted at a team resolves to the members that the
 * team holds now, including one who joined after the task was created and
 * without a new publication. A principal that is not a team resolves to
 * nobody, so `resolveTarget` sends the task to Unroutable (I10, AS-5). It is a
 * pure function of the log (I4, I6).
 */
export function teamMembership(log: Log): Membership {
  const teams = teamsOf(log)
  return (principal) => teams.find((team) => team.name === principal)?.members ?? []
}

/** Authorize one team change (AS-6, AC-1, I8). The engine is the only evaluator. */
function assertTeamsAllowed(actor: ActorId, grants: readonly Grant[]): void {
  if (!authorize(grants, TEAM_SCOPE, 'org')) {
    throw new Error(
      `teams: ${actor} needs the scope ${TEAM_SCOPE} on org to create or maintain a team (AS-6)`
    )
  }
}

/** Read one team change from a `config.team.changed@1` payload. A malformed payload throws. */
function readTeamChange(payload: Readonly<Record<string, unknown>>): TeamChangePayload {
  const { team, change, member } = payload
  if (typeof team !== 'string') {
    throw new Error('teams: the team must be a string')
  }
  if (change !== 'created' && change !== 'member-added' && change !== 'member-removed') {
    throw new Error('teams: the change must be created, member-added or member-removed')
  }
  if (member !== undefined && typeof member !== 'string') {
    throw new Error('teams: the member must be a string')
  }
  return { team, change, member }
}
