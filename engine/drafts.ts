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
//
// The store is a scaffold: the types and the surface below are fixed, and the
// behavior arrives in the next commit, when the suite stops expecting the
// first check to fail (#21).

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

/** Save one edit under `id` (I15, RT-3). Not implemented yet (#21). */
export function saveDraft(
  _session: DraftSession,
  _id: string,
  _edit: Readonly<Record<string, unknown>>
): DraftSession {
  throw new Error('drafts: saveDraft is not implemented yet (I15, #21)')
}

/** Mark the held draft `id` synced (I15). Not implemented yet (#21). */
export function syncDraft(_session: DraftSession, _id: string): DraftSession {
  throw new Error('drafts: syncDraft is not implemented yet (I15, #21)')
}

/** Discard the held draft `id` (I15). Not implemented yet (#21). */
export function discardDraft(_session: DraftSession, _id: string): DraftSession {
  throw new Error('drafts: discardDraft is not implemented yet (I15, #21)')
}

/** The recoverable drafts of a store (I15). Not implemented yet (#21). */
export function recoverable(_store: DraftStore): DraftStore {
  throw new Error('drafts: recoverable is not implemented yet (I15, #21)')
}
