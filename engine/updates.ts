// Issue #22, I16, A4, ADR 0007: the optimistic update store.
//
// I16: the interface never shows an unconfirmed state as confirmed. An
// optimistic update is applied to the local state immediately and shown as
// `pending` until the server acknowledges it; only then does it become
// `confirmed`. The interface shows the confirmed set through the
// `confirmedOnly` projection, which drops every pending update, so it can only
// ever show confirmed as confirmed. This complements I15 (a saved edit is
// never lost) with the honesty rule (an unconfirmed edit is never shown as
// confirmed). This model is pure and deterministic (I6): it reads no clock, no
// random source and no I/O of its own.
//
// The store is a scaffold: the types and the surface below are fixed, and the
// behavior arrives in the next commit, when the suite stops expecting the
// first check to fail (#22).

/**
 * The state of one optimistic update (I16). `pending` is optimistically
 * applied and not acknowledged by the server. `confirmed` is acknowledged by
 * the server.
 */
export type UpdateState = 'pending' | 'confirmed'

/**
 * One optimistic update: the edit that the interface applied under an id, and
 * the state that it shows (I16).
 */
export type Update = {
  readonly id: string
  readonly edit: Readonly<Record<string, unknown>>
  readonly state: UpdateState
}

/** The optimistic updates that the interface holds, in the order that they were applied (I16). */
export type UpdateLog = readonly Update[]

/** The log before any optimistic edit (I16): nothing applied, nothing acknowledged. */
export const emptyUpdates: UpdateLog = []

/** Apply one optimistic update under `id` (I16). Not implemented yet (#22). */
export function applyOptimistic(
  _updates: UpdateLog,
  _id: string,
  _edit: Readonly<Record<string, unknown>>
): UpdateLog {
  throw new Error('updates: applyOptimistic is not implemented yet (I16, #22)')
}

/** Acknowledge the update `id` (I16). Not implemented yet (#22). */
export function acknowledge(_updates: UpdateLog, _id: string): UpdateLog {
  throw new Error('updates: acknowledge is not implemented yet (I16, #22)')
}

/** The confirmed updates of a log (I16). Not implemented yet (#22). */
export function confirmedOnly(_updates: UpdateLog): UpdateLog {
  throw new Error('updates: confirmedOnly is not implemented yet (I16, #22)')
}
