import { isDeepStrictEqual } from 'node:util'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Operation } from '../../engine/operation.js'
import { isClientIntent, resolveClientOperation } from '../../server/intents.js'
import { directoryOf, grantsApplying, groupsOf } from './directory.js'
import {
  clockOf,
  goldenView,
  type Scenario,
  type StateView,
  type Step,
  type StepClock,
  stepOperation,
  toView,
} from './scenario.js'

// Issue #256, STORIES.md Oracles, ADR 0010, I6: the engine's prediction of a
// run. A step that declares an intent resolves through the same resolver as
// the release server, against the state the earlier steps produced, with the
// scenario's grants and directory; a step without one is appended as it
// stands. The engine decides each step: it is applied, or it is refused with
// a status and a reason, and a refused step changes nothing. The prediction
// is pure and deterministic (I6), so an operator that varies a golden path
// (another actor, a moved clock, a new version, other data) predicts its
// deviation here, and the api run must reproduce it step by step.

/** What the engine decided for one step: the operation it applied, or the refusal. */
export type StepOutcome =
  | { readonly operation: Operation }
  | { readonly status: number; readonly error: string }

/** The prediction of a run: the end state and the outcome of every step, in step order. */
export type Prediction = {
  readonly state: State
  readonly outcomes: readonly StepOutcome[]
}

/** Two operations are the same change when they are equal as JSON (I1): an absent key and an undefined one are one thing on the wire. */
export function sameOperation(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))
}

/** Whether a scenario has a step that posts an intent (ADR 0010). */
export function hasIntents(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.intent !== undefined)
}

/** The operation a step posts: the declared operation, with the intent as its payload when it has one. */
export function postedOperation(step: Step, index: number, clock: StepClock): Operation {
  const operation = stepOperation(step, index, clock)
  return step.intent === undefined ? operation : { ...operation, payload: step.intent }
}

/**
 * Decide one step against a state (ADR 0010, I8): resolve the intent through
 * the shared resolver, or append the declared operation. An operation whose
 * id the state already applied is the same change, so it is applied again as
 * a no-op (I1) and reported as the event the log holds.
 */
export function decide(
  scenario: Scenario,
  state: State,
  step: Step,
  index: number,
  clock: StepClock
): StepOutcome {
  const posted = postedOperation(step, index, clock)
  const applied = state.log.find((event) => event.operationId === posted.id)
  if (applied !== undefined) {
    return {
      operation: {
        id: applied.operationId,
        type: applied.type,
        at: applied.at,
        actor: applied.actor,
        payload: applied.payload,
      },
    }
  }
  const body = posted as unknown as Record<string, unknown>
  if (step.intent === undefined || !isClientIntent(body)) return { operation: posted }
  const actor = posted.actor ?? ''
  const resolved = resolveClientOperation(
    {
      log: state.log,
      principal: { id: actor, groups: groupsOf(scenario.membership, actor) },
      grants: grantsApplying(state.log, actor, scenario.bootstrap, scenario.membership),
      resolver: directoryOf(state.log, scenario.membership, scenario.managers),
      now: () => posted.at,
    },
    body
  )
  if ('error' in resolved) return { status: resolved.status, error: resolved.error }
  return { operation: resolved.operation }
}

/**
 * Continue a run from a state: decide and apply the steps from `from` on,
 * and drop each refused step (the deviation the engine predicts).
 */
export function continueFrom(
  scenario: Scenario,
  state: State,
  from: number,
  clock: StepClock = clockOf(scenario)
): Prediction {
  let current = state
  const outcomes: StepOutcome[] = []
  for (let i = from; i < scenario.steps.length; i += 1) {
    const outcome = decide(scenario, current, scenario.steps[i], i, clock)
    outcomes.push(outcome)
    if ('operation' in outcome) current = apply(outcome.operation, current)
  }
  return { state: current, outcomes }
}

/** The engine's prediction of a whole run under a step clock (I6). */
export function predict(scenario: Scenario, clock: StepClock = clockOf(scenario)): Prediction {
  return continueFrom(scenario, emptyState, 0, clock)
}

/**
 * The predicted end state of a scenario (STORIES.md, Oracles): the golden end
 * state of a golden path, and the deviation the engine predicts for a fuzzy
 * path. A scenario without an intent is the raw replay of its steps.
 */
export function predictedView(scenario: Scenario, clock: StepClock = clockOf(scenario)): StateView {
  return toView(predict(scenario, clock).state)
}

/**
 * A golden path declares each resolved event next to its intent (ADR 0010):
 * the engine must accept every step and resolve it to exactly the declared
 * event. The check is what makes the declared payloads evidence rather than
 * documentation; a fuzzy path is held to the prediction instead.
 */
export function assertGoldenDeclared(
  scenario: Scenario,
  clock: StepClock = clockOf(scenario)
): void {
  const { outcomes } = predict(scenario, clock)
  outcomes.forEach((outcome, index) => {
    if ('error' in outcome) {
      throw new Error(
        `step ${index + 1}: the engine refused the golden step: HTTP ${outcome.status} ${outcome.error}`
      )
    }
    const declared = stepOperation(scenario.steps[index], index, clock)
    if (!sameOperation(outcome.operation, declared)) {
      throw new Error(
        `step ${index + 1}: the resolved event differs from the declared step\n${JSON.stringify(outcome.operation)}\n${JSON.stringify(declared)}`
      )
    }
  })
}

/** The state after the first `count` steps, as the engine predicts it (I4, I5): the shared view of a race or a fault. */
export function prefix(
  scenario: Scenario,
  count: number,
  clock: StepClock = clockOf(scenario)
): State {
  let state = emptyState
  for (let i = 0; i < count; i += 1) {
    const outcome = decide(scenario, state, scenario.steps[i], i, clock)
    if ('operation' in outcome) state = apply(outcome.operation, state)
  }
  return state
}

/**
 * The end state a run must reach (STORIES.md, Oracles): the engine's
 * prediction for a scenario with intents, and the raw replay of the declared
 * steps for one without (a scenario the server appends as it stands).
 */
export function expectedView(scenario: Scenario, clock: StepClock = clockOf(scenario)): StateView {
  return hasIntents(scenario) ? predictedView(scenario, clock) : goldenView(scenario, clock)
}
