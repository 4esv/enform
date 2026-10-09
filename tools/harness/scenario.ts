import { apply, emptyState, type State } from '../../engine/apply.js'
import {
  type ActorId,
  createOperation,
  type Event,
  type Operation,
} from '../../engine/operation.js'
import { createOutboxOperation, type OutboxEntry } from '../../engine/outbox.js'

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
  /** The side effects that the step causes (I2); absent when it causes none. */
  readonly outbox?: readonly OutboxEntry[]
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

/** The engine state of a state view (the inverse of toView, I4). */
export function fromView(view: StateView): State {
  return { applied: new Set(view.applied), log: view.log }
}

/**
 * The operation that one step appends (I2): a step with side effects carries
 * them in the same operation, so one `apply` commits the state change and its
 * side effects together. A step with no side effect keeps its payload.
 */
export function stepOperation(step: Step, index: number): Operation {
  const deps = { clock: () => index + 1, ids: () => `op-${index + 1}` }
  const outbox = step.outbox ?? []
  return outbox.length > 0
    ? createOutboxOperation(step.type, step.payload, outbox, deps, step.actor)
    : createOperation(step.type, step.payload, deps, step.actor)
}

// The engine-side replay of the steps (I6): the golden end state that a run
// must reproduce. The clock is the step index and the IDs are `op-N`.
export function goldenView(value: Scenario): StateView {
  let state = emptyState
  value.steps.forEach((step, i) => {
    state = apply(stepOperation(step, i), state)
  })
  return toView(state)
}
