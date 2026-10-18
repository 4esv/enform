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

/**
 * One value that a gui action fills into a control (FM-1, FM-7). A string,
 * number or boolean fills one control; a string list checks the boxes of a
 * checkbox group whose value is in the list (multi-select).
 */
export type GuiFillValue = string | number | boolean | readonly string[]

/** The DOM that one field must render (FM-1): its tag, its input type and its count. */
export type GuiDomExpectation = {
  readonly field: string
  readonly tag: string
  readonly type?: string
  readonly count?: number
}

/**
 * One gui action: fill a field, click a control, expect a status text, or
 * expect the DOM of a field.
 */
export type GuiAction =
  | { readonly fill: { readonly field: string; readonly value: GuiFillValue } }
  | { readonly click: string }
  | { readonly expect: string }
  | { readonly expectDom: GuiDomExpectation }

/** One gui step, index-aligned with the scenario step at the same index (STORIES.md). */
export type GuiStep = {
  /** An interface page within the app; absent means the default form page. */
  readonly page?: string
  readonly actions: readonly GuiAction[]
}

export type Scenario = {
  /** The story slug (STORIES.md): it names the story, not the flow. */
  readonly slug: string
  /** The flow slug that the interface path opens (the `/app/?slug=` value). */
  readonly flowSlug?: string
  readonly steps: readonly Step[]
  /**
   * The interface path, a prefix of `steps` (STORIES.md, Golden path: `gui` is
   * the same steps in a browser). A gui step maps to the engine step at the
   * same index. The path may declare fewer steps than `steps`, because an
   * interface path that does not yet exist covers only a prefix; it may never
   * be longer than `steps`.
   */
  readonly gui?: readonly GuiStep[]
}

/** The state as the HTTP API returns it (applied IDs as an array). */
export type StateView = {
  readonly applied: string[]
  readonly log: readonly Event[]
}

export function scenario(value: Scenario): Scenario {
  assertGuiPath(value)
  return value
}

/** Refuse a gui path longer than the steps it maps to (STORIES.md, Golden path). */
function assertGuiPath(value: Scenario): void {
  if (value.gui !== undefined && value.gui.length > value.steps.length) {
    throw new Error('gui: the gui path is longer than the scenario steps')
  }
  if (value.gui !== undefined && value.flowSlug === undefined) {
    throw new Error('gui: the gui path needs a flowSlug to open the form')
  }
}

export function toView(state: State): StateView {
  return { applied: [...state.applied], log: state.log }
}

/** The engine state of a state view (the inverse of toView, I4). */
export function fromView(view: StateView): State {
  return { applied: new Set(view.applied), log: view.log }
}

/**
 * The injected clock of a golden path (I6): it gives the time of each step.
 * The engine reads no clock of its own, so a caller can move it (the Clock
 * operator) and get the same state with different `at` values.
 */
export type StepClock = (stepIndex: number) => number

/** The golden step clock (I6): step i happens at time i + 1. */
export const goldenClock: StepClock = (index) => index + 1

/**
 * The operation that one step appends (I2): a step with side effects carries
 * them in the same operation, so one `apply` commits the state change and its
 * side effects together. A step with no side effect keeps its payload. The
 * operation's `at` comes from the step clock (I6).
 */
export function stepOperation(
  step: Step,
  index: number,
  clock: StepClock = goldenClock
): Operation {
  const deps = { clock: () => clock(index), ids: () => `op-${index + 1}` }
  const outbox = step.outbox ?? []
  return outbox.length > 0
    ? createOutboxOperation(step.type, step.payload, outbox, deps, step.actor)
    : createOperation(step.type, step.payload, deps, step.actor)
}

// The engine-side replay of the steps (I6): the golden end state that a run
// must reproduce. The clock is the step clock and the IDs are `op-N`.
export function goldenView(value: Scenario, clock: StepClock = goldenClock): StateView {
  let state = emptyState
  value.steps.forEach((step, i) => {
    state = apply(stepOperation(step, i, clock), state)
  })
  return toView(state)
}

/**
 * The golden end state of a prefix of a scenario's steps (I6): the state after
 * the first `count` steps. A gui run covers a prefix, so its end state is this
 * view, not the full golden view. `count` must not exceed the scenario's steps.
 */
export function goldenViewPrefix(
  value: Scenario,
  count: number,
  clock: StepClock = goldenClock
): StateView {
  let state = emptyState
  for (let i = 0; i < count; i += 1) {
    state = apply(stepOperation(value.steps[i], i, clock), state)
  }
  return toView(state)
}
