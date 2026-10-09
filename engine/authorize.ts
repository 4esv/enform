// Issue #14, I8, AC-1, AC-4, A3, A9, MVP.md 5.6: the authorization model.
//
// I8: the server authorizes every read and write, and a subscriber never
// receives an event that it cannot see. AC-1: authorization is a pure function
// of grants, scope and resource, and only the engine evaluates it. This module
// is that function. It reads no clock, no ID source and no other state (I6).

import type { ActorId } from './operation.js'

/**
 * One grant (MVP.md 5.6): a principal, one or more scopes, and one resource.
 * The principal is a user, a group or a team. The resource is `org`,
 * `flow:<slug>` or `flow:<slug>/step:<key>`, and a grant on a flow applies to
 * all of its steps.
 */
export type Grant = {
  /** Who holds the grant: a user, a group or a team (MVP.md 5.6, ID-4). */
  readonly principal: ActorId
  /** The scopes that the principal holds, for example `flow.read` or `step.outcome:approve`. */
  readonly scopes: readonly string[]
  /** What the grant applies to: `org`, `flow:<slug>` or `flow:<slug>/step:<key>`. */
  readonly resource: string
}

/**
 * The segments of a resource pattern (MVP.md 5.6). `org` is one segment,
 * `flow:<slug>` is `flow` then the slug, and `flow:<slug>/step:<key>` adds
 * `step` then the key. `*` is the wildcard: a segment that matches any one
 * segment, so a pattern of only `*` matches every resource. `undefined` is a
 * form that the format does not allow.
 */
function resourceSegments(resource: string): readonly string[] | undefined {
  const segments: string[] = []
  for (const part of resource.split('/')) {
    const separator = part.indexOf(':')
    if (separator === -1) {
      if (part !== 'org' && part !== '*') return undefined
      segments.push(part)
      continue
    }
    const head = part.slice(0, separator)
    const value = part.slice(separator + 1)
    if (value.length === 0 || (head !== 'flow' && head !== 'step')) return undefined
    segments.push(head, value)
  }
  return segments
}

/**
 * Whether a grant resource covers a queried resource (MVP.md 5.6). Every
 * segment of the pattern matches the segment at the same position: a segment
 * matches when it is equal, or when it is the wildcard `*`. A shorter pattern
 * covers a longer query, so a grant on `flow:<slug>` covers every
 * `flow:<slug>/step:<key>` under it.
 */
function covers(pattern: readonly string[], query: readonly string[]): boolean {
  if (pattern.length > query.length) return false
  return pattern.every((segment, index) => segment === '*' || segment === query[index])
}

/**
 * Authorize one action (I8, AC-1). It is a pure function of the grants that
 * the acting principal holds, the scope of the action and the resource that
 * the action touches: it reads no clock, no ID source and no other state (I6).
 * The caller passes the grants that apply to the principal, its own grants and
 * those of the groups and the teams that it belongs to.
 *
 * The function returns true when one grant holds the scope exactly and its
 * resource covers the queried resource. A scope matches exactly, so a
 * `step.outcome:<name>` scope authorizes that outcome and no other (AC-4).
 */
export function authorize(grants: readonly Grant[], scope: string, resource: string): boolean {
  const query = resourceSegments(resource)
  if (query === undefined) return false
  return grants.some((grant) => {
    if (!grant.scopes.includes(scope)) return false
    const pattern = resourceSegments(grant.resource)
    return pattern !== undefined && covers(pattern, query)
  })
}
