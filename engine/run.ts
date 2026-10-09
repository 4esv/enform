// Issue #12, I6, A6, ADR 0004: the deterministic run seam.
// Issue #13, I7, A6: the side-effect sink, live or dry.

import { apply, emptyState, type State } from './apply.js'
import { type ActorId, type Clock, createOperation, type IdGenerator } from './operation.js'
import type { OutboxEntry } from './outbox.js'

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
  /** Who made the change (I14); absent when the step affects no behavior. */
  readonly actor?: ActorId
  /** The side effects that the step causes (I2); absent when it causes none. */
  readonly outbox?: readonly OutboxEntry[]
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

/** The side-effect sink of a run (I7): `live` commits each side effect, `dry` previews it. */
export type Sink = 'live' | 'dry'

/** The injected sources of a sink-aware run (I7): the clock, the ID generator and the sink. */
export type RunSources = Sources & { readonly sink: Sink }

/** The outcome of a run (I7): the end state and the side-effect intents that it produced. */
export type RunResult = {
  /** The end state. A live run carries its committed side effects; a dry run writes no event (A6). */
  readonly state: State
  /** The side effects that the run produced, in step order (I7). */
  readonly intents: readonly OutboxEntry[]
}

/**
 * Run a sequence of steps and send the side effects that they cause to the
 * sink (I7). Scaffold for issue #13: the sink is not wired yet, so the run
 * commits every step with the sink-less `deterministicRun` and reports no
 * intent. The next commit replaces this with the full run loop.
 */
export function runSteps(steps: readonly Step[], sources: RunSources): RunResult {
  return { state: deterministicRun(steps, sources), intents: [] }
}
