// Issue #12, I6, A6, ADR 0004: the deterministic run seam.

import { apply, emptyState, type State } from './apply.js'
import { type Clock, createOperation, type IdGenerator } from './operation.js'

/**
 * The injected sources of a run: the clock and the operation ID generator
 * (I6). A run takes them as arguments, so it reads no clock and no random
 * source of its own, and a test can give it the same sources twice.
 */
export type Sources = {
  readonly clock: Clock
  readonly ids: IdGenerator
}

/** One step of a run: the event type that the operation records, and its payload. */
export type Step = {
  readonly type: string
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * Run a sequence of steps from the injected sources (I6). The same steps and
 * the same sources give the same state.
 */
export function deterministicRun(steps: readonly Step[], sources: Sources): State {
  let state = emptyState
  for (const step of steps) {
    const operation = createOperation(step.type, step.payload, {
      clock: sources.clock,
      ids: sources.ids,
    })
    state = apply(operation, state)
  }
  return state
}
