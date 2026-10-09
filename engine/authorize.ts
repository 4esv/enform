// Issue #14, I8, AC-1, AC-4, A3, A9, MVP.md 5.6: the authorization model.
//
// I8: the server authorizes every read and write, and a subscriber never
// receives an event that it cannot see. AC-1: authorization is a pure function
// of grants, scope and resource, and only the engine evaluates it. This
// scaffold holds the shape of that function; the model that the I8 suite needs
// arrives with commit 2. It reads no clock, no ID source and no other state
// (I6).

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
 * The scaffold of the authorization function (I8, AC-1). It matches the scope
 * and the resource exactly, so it does not yet cover the wildcard and the
 * prefix rules of MVP.md 5.6. Commit 2 replaces it with the full model.
 */
export function authorize(grants: readonly Grant[], scope: string, resource: string): boolean {
  return grants.some((grant) => grant.scopes.includes(scope) && grant.resource === resource)
}
