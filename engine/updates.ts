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

/**
 * Apply one optimistic update under `id` (I16): the interface applies the edit
 * to its local state immediately and shows it as `pending` until the server
 * acknowledges it. Applying an id again replaces its update and returns it to
 * `pending`, because the newer edit is not acknowledged yet.
 */
export function applyOptimistic(
  updates: UpdateLog,
  id: string,
  edit: Readonly<Record<string, unknown>>
): UpdateLog {
  const update: Update = { id, edit, state: 'pending' }
  return [...updates.filter((entry) => entry.id !== id), update]
}

/**
 * Acknowledge the update `id` (I16): the server accepted the edit, so the
 * interface moves it from `pending` to `confirmed`. An update that the
 * interface does not hold leaves the log unchanged.
 */
export function acknowledge(updates: UpdateLog, id: string): UpdateLog {
  return updates.map((update) => (update.id === id ? { ...update, state: 'confirmed' } : update))
}

/**
 * The confirmed updates (I16): the updates that the server acknowledged. It
 * never includes a pending update, so the interface can only ever show
 * confirmed as confirmed. It is the honest view of the confirmed set.
 */
export function confirmedOnly(updates: UpdateLog): UpdateLog {
  return updates.filter((update) => update.state === 'confirmed')
}
