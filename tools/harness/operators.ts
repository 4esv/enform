import type { Grant } from '../../engine/authorize.js'
import type { ActorId, Log } from '../../engine/operation.js'
import { oracles } from './oracles.js'
import { type Deliveries, runSteps } from './runner.js'
import type { Scenario, Step } from './scenario.js'

// Issue #31, STORIES.md Fuzzy paths: variation operators generate fuzzy paths
// from a golden path. Duplicate sends each operation two times; the end state
// does not change (I1, I3).

export type Operator = {
  readonly id: string
  /** How many times to deliver each step's operation (same ID). */
  readonly deliveries: Deliveries
}

/** Duplicate: send each operation two times. The second send is a no-op (I1). */
export const DUPLICATE: Operator = { id: 'Duplicate', deliveries: () => 2 }

/** Run one fuzzy path of a golden path, then check it against the oracles. */
export async function runOperator(scenario: Scenario, operator: Operator): Promise<void> {
  const { state } = await runSteps(scenario, { mode: 'api', deliveries: operator.deliveries })
  oracles(state, scenario)
}

// Issue #30, STORIES.md Fuzzy paths: the Actor operator does each step of a
// golden path as each person in the cast (STORIES.md, Cast). The expected
// result comes from the grants of that person (MVP.md 5.6, I8): the engine's
// `authorize` accepts the step and the run reaches the golden end state, or it
// refuses the step and the run deviates by exactly that operation. The runner
// generates the variants from the golden path in step order, then cast order,
// so no fuzzy test is written by hand and the run is deterministic (I6).
//
// This is the #30 scaffold: the test lands first and fails; the next commit
// implements the generator and the run.

/** The cast: a principal to the grants that apply to it (STORIES.md, Cast; AC-1). */
export type Cast = Readonly<Record<ActorId, readonly Grant[]>>

/** What one step requires of its actor: the scope of the action and the resource (MVP.md 5.6, I8). */
type Requirement = {
  readonly scope: string
  readonly resource: string
}

/** The requirement of a step of the scenario, in step order. */
export type Requirements = (step: Step, stepIndex: number) => Requirement

/** One generated Actor variant: one step of the golden path, done by one person of the cast. */
export type ActorVariant = {
  readonly id: string
  readonly stepIndex: number
  readonly actor: ActorId
  /** The engine's prediction (I8): the person holds the step's scope, or the engine refuses it. */
  readonly expected: 'reached' | 'refused'
  /** The golden path with the step's actor swapped for the person. */
  readonly scenario: Scenario
}

/** The cast of a log: the grants that each principal holds, read back with `grantsOf` (I4, AC-1). */
export function castOf(_log: Log): Cast {
  return {}
}

/** Generate one Actor variant per step and per person of the cast (STORIES.md, Fuzzy paths). */
export function actorVariants(
  _scenario: Scenario,
  _cast: Cast,
  _requires: Requirements
): readonly ActorVariant[] {
  return []
}

/** Run the Actor operator over a golden path: every variant runs, the oracles check it. */
export async function runActorOperator(
  _scenario: Scenario,
  _cast: Cast,
  _requires: Requirements
): Promise<readonly ActorVariant[]> {
  return []
}
