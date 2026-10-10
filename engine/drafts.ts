// Issue #21, I15, A4, A7, RT-3, ADR 0007: the local-first draft store.
//
// I15: if the interface shows "Saved on this device", the edit gets to the
// server, or it stays recoverable on the device until a deliberate deletion.
// The interface always shows the difference between "Saved on this device" and
// "Synced". A draft is the edit that the device holds under one draft id, and
// its state is the one the interface shows: `saved` before the server
// acknowledges the edit, `synced` after. A save never drops the edit: the edit
// either becomes `synced`, or it stays `saved` and recoverable, until a
// deliberate discard. This model is pure and deterministic (I6): it reads no
// clock, no random source and no I/O of its own.

/**
 * The state of one held draft (I15). `saved` is "Saved on this device": the
 * device holds the edit and the server has not acknowledged it. `synced` is
 * "Synced": the server acknowledged the edit.
 */
export type DraftState = 'saved' | 'synced'

/**
 * One draft: the edit that the device holds under a draft id, and the state
 * that the interface shows (I15).
 */
export type Draft = {
  readonly id: string
  readonly edit: Readonly<Record<string, unknown>>
  readonly state: DraftState
}

/** The drafts that the device holds, in the order that they were saved (I15). */
export type DraftStore = readonly Draft[]

/**
 * The local-first draft session that I15 is checked against (A4, A7). `saved`
 * is the append-only record of every edit that the device saved, `held` are
 * the drafts that it still holds, with the state that the interface shows, and
 * `discarded` names the ids that a deliberate deletion released. A save adds
 * to the record and to the store, a sync moves a held draft to `synced`, and
 * only a deliberate discard moves an id out of the store.
 */
export type DraftSession = {
  readonly saved: readonly Draft[]
  readonly held: DraftStore
  readonly discarded: readonly string[]
}

/** The session before any edit (I15): nothing saved, nothing held, nothing discarded. */
export const emptySession: DraftSession = { saved: [], held: [], discarded: [] }

/**
 * Save one edit under `id` (I15, RT-3): the edit becomes a held draft in state
 * `saved`, so the interface shows "Saved on this device" until the server
 * acknowledges it. Saving an id again replaces its held edit and returns it to
 * `saved`, because the newer edit is not acknowledged yet. The `saved` record
 * keeps every save, so a dropped edit stays visible (I15).
 */
export function saveDraft(
  session: DraftSession,
  id: string,
  edit: Readonly<Record<string, unknown>>
): DraftSession {
  const draft: Draft = { id, edit, state: 'saved' }
  return {
    saved: [...session.saved, draft],
    held: [...session.held.filter((entry) => entry.id !== id), draft],
    discarded: session.discarded.filter((discarded) => discarded !== id),
  }
}

/**
 * Mark the held draft `id` synced (I15): the server acknowledged the edit, so
 * the interface shows "Synced". A draft that the device does not hold leaves
 * the session unchanged.
 */
export function syncDraft(session: DraftSession, id: string): DraftSession {
  return {
    ...session,
    held: session.held.map((draft) => (draft.id === id ? { ...draft, state: 'synced' } : draft)),
  }
}

/**
 * Discard the held draft `id` (I15): a deliberate deletion releases the edit
 * from the device, and it is the only operation that removes a held draft. The
 * id stays on the record as a deliberate discard, so it is not a loss.
 */
export function discardDraft(session: DraftSession, id: string): DraftSession {
  return {
    saved: session.saved,
    held: session.held.filter((draft) => draft.id !== id),
    discarded: [...session.discarded, id],
  }
}

/**
 * The recoverable drafts (I15): the drafts of a store that are saved on the
 * device and not yet synced. They are the edits that the device must not lose
 * before a deliberate discard, and the ones that the interface marks "Saved on
 * this device".
 */
export function recoverable(store: DraftStore): DraftStore {
  return store.filter((draft) => draft.state === 'saved')
}
