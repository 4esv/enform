import type { Grant } from '../../engine/authorize.js'
import type { ActorId, Log } from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { teamsOf } from '../../engine/teams.js'
import { grantsFor, resolverFor } from '../../server/intents.js'

// Issue #256, AS-1, AS-4, AC-1, I8: the directory of the harness. A release
// server reads a principal's groups from its session, the teams from the log
// and the grants from the log; the harness has no session, so the groups come
// from the scenario's `membership` seam, and everything else comes from the
// same engine reads as the release server. Every mode (api, cli, dry) and the
// prediction read this one directory, so they agree by construction (I6).

/** The groups of the cast, keyed by principal id (ID-4): the `membership` seam of a scenario. */
export type Membership = Readonly<Record<string, readonly string[]>>

/** The manager of each principal, keyed by principal id (AS-1, #267): the `managers` seam of a scenario. */
export type Managers = Readonly<Record<string, string>>

/** The groups one principal holds (ID-4): none when the membership does not name it. */
export function groupsOf(membership: Membership | undefined, actor: ActorId): readonly string[] {
  return membership?.[actor] ?? []
}

/**
 * The grants that apply to one principal (AC-1, I8): the bootstrap grants that
 * name it or one of its groups, and the grants the log records for it, read
 * through the same `grantsFor` as the release server.
 */
export function grantsApplying(
  log: Log,
  actor: ActorId,
  bootstrap: readonly Grant[] | undefined,
  membership: Membership | undefined
): readonly Grant[] {
  const groups = groupsOf(membership, actor)
  const held = new Set([actor, ...groups, ...groups.map((group) => `group:${group}`)])
  const seeded = (bootstrap ?? []).filter((grant) => held.has(grant.principal))
  return [...seeded, ...grantsFor(log, { id: actor, groups })]
}

/**
 * The directory resolver of the harness (AS-1, AS-4): the release server's
 * `resolverFor`, over the teams the log holds now (AS-6) and the groups the
 * membership seam gives. A team target resolves to the members the team holds
 * at resolution time, so a member who joined after the task was created is
 * reached (S08, I13); a group target resolves to the principals whose
 * membership names the group.
 */
export function directoryOf(
  log: Log,
  membership: Membership | undefined,
  managers?: Managers
): (starter: ActorId | undefined, data: Readonly<Record<string, unknown>>) => TargetResolver {
  void managers
  const teamMembers = new Map(teamsOf(log).map((team) => [team.name, team.members]))
  const groupMembers = new Map<string, string[]>()
  for (const [principal, groups] of Object.entries(membership ?? {})) {
    for (const group of groups) {
      const members = groupMembers.get(group)
      if (members === undefined) groupMembers.set(group, [principal])
      else members.push(principal)
    }
  }
  return (starter, data) => resolverFor(starter, data, teamMembers, groupMembers)
}
