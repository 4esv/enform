// Issue #11, I5, A1, I4, ADR 0004: the optimistic version check.
//
// I5: no blocking locks. A read or an edit never waits for another user. Only
// step completion is serialized, with an optimistic version check. This engine
// never takes a lock and never waits: a completion carries the version that it
// was based on, and the engine applies it only when that version is still
// current. A completion on a stale version is rejected at once, and the caller
// re-reads and retries. A read is a pure function of the log, so it is
// immediate (I4).

import { apply, type State } from './apply.js'
import type { Operation } from './operation.js'

/**
 * The version of the state: one per committed event, in log order (I4). The
 * empty state is version 0. Every applied operation advances the version by
 * one, so the version is the log position that a completion is based on.
 */
export type Version = number

/** The current version of a state: its log position (I4). A pure read. */
export function version(state: State): Version {
  return state.log.length
}

/**
 * The result of a completion (I5). `accepted` says whether the completion
 * applied. When it did not, the state is unchanged and the completion was
 * based on a stale version: the caller re-reads and retries. The engine never
 * waits and never mutates the input state.
 */
export type CompletionResult = {
  readonly accepted: boolean
  readonly state: State
}

/**
 * Complete a step with an optimistic version check (I5, A1). `expectedVersion`
 * is the version that the completion was based on. When it is the current
 * version, the engine applies the completion and returns the new state. When it
 * is stale, the engine rejects the completion at once and returns the state
 * unchanged, so nobody blocks: the caller re-reads and retries. Nothing runs
 * in place (I4).
 */
export function completeStep(
  state: State,
  expectedVersion: Version,
  completion: Operation
): CompletionResult {
  if (expectedVersion !== version(state)) {
    return { accepted: false, state }
  }
  return { accepted: true, state: apply(completion, state) }
}
