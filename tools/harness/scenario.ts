import { apply, emptyState, type State } from '../../engine/apply.js'
import { createOperation, type ActorId, type Event } from '../../engine/operation.js'

// Issue #24, STORIES.md Test method: one executable scenario per story. Its
// steps are "a person acts, then a condition must be true". The runner
// executes them in a mode (api, cli, dry, gui) and compares the end state to
// the golden end state. The golden end state is the deterministic engine
// replay of the steps (I6).

export type Step = {
  /** The principal who acts (an immutable directory ID, ID-4). */
  readonly actor: ActorId
  /** The versioned event type of the operation the step appends. */
  readonly type: string
  /** The payload of the operation the step appends. */
  readonly payload: Readonly<Record<string, unknown>>
}

export type Scenario = {
  readonly slug: string
  readonly steps: readonly Step[]
}

/** The state as the HTTP API returns it (applied IDs as an array). */
export type StateView = {
  readonly applied: string[]
  readonly log: readonly Event[]
}

export function scenario(value: Scenario): Scenario {
  return value
}

export function toView(state: State): StateView {
  return { applied: [...state.applied], log: state.log }
}

// The engine-side replay of the steps (I6): the golden end state that a run
// must reproduce. The clock is the step index and the IDs are `op-N`.
export function goldenView(value: Scenario): StateView {
  let state = emptyState
  value.steps.forEach((step, i) => {
    const operation = createOperation(
      step.type,
      step.payload,
      { clock: () => i + 1, ids: () => `op-${i + 1}` },
      step.actor
    )
    state = apply(operation, state)
  })
  return toView(state)
}
