import { authorize, type Grant } from '../../engine/authorize.js'
import { grantsOf } from '../../engine/grants.js'
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

/** The cast: a principal to the grants that apply to it (STORIES.md, Cast; AC-1). */
export type Cast = Readonly<Record<ActorId, readonly Grant[]>>

/** What one step requires of its actor: the scope of the action and the resource (MVP.md 5.6, I8). */
type Requirement = {
  readonly scope: string
  readonly resource: string
}

/** The requirement of a step of the scenario, in step order. */
export type Requirements = (step: Step, stepIndex: number) => Requirement

/** The cast of a log: the grants that each principal holds, read back from the log (I4, AC-1). */
export function castOf(log: Log): Cast {
  const cast: Record<ActorId, Grant[]> = {}
  for (const grant of grantsOf(log)) {
    const held = cast[grant.principal]
    if (held === undefined) cast[grant.principal] = [grant]
    else held.push(grant)
  }
  return cast
}

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

/**
 * Generate one Actor variant per step and per person of the cast (STORIES.md,
 * Fuzzy paths). The prediction uses the engine's `authorize` only (AC-1): a
 * person who holds the step's scope reaches the golden end state, and a person
 * who does not hold it is refused.
 */
export function actorVariants(
  scenario: Scenario,
  cast: Cast,
  requires: Requirements
): readonly ActorVariant[] {
  const variants: ActorVariant[] = []
  for (const [person, grants] of Object.entries(cast)) {
    scenario.steps.forEach((step, index) => {
      const { scope, resource } = requires(step, index)
      variants.push({
        id: `actor:step${index + 1}:${person}`,
        stepIndex: index,
        actor: person,
        expected: authorize(grants, scope, resource) ? 'reached' : 'refused',
        scenario: swapActor(scenario, index, person),
      })
    })
  }
  return variants
}

/**
 * Run the Actor operator over a golden path: every variant runs, and the
 * oracles check it (STORIES.md, Oracles). An authorized person reaches the
 * variant's golden end state. An unauthorized person is refused by the
 * engine's `authorize` (I8), so the runner refuses the step and the end state
 * is the golden path without that operation, the deviation that the operator
 * predicts. The variants are returned, so a test can count them.
 */
export async function runActorOperator(
  scenario: Scenario,
  cast: Cast,
  requires: Requirements
): Promise<readonly ActorVariant[]> {
  const variants = actorVariants(scenario, cast, requires)
  for (const variant of variants) {
    const expected =
      variant.expected === 'reached' ? variant.scenario : withoutStep(scenario, variant.stepIndex)
    const { state } = await runSteps(expected, { mode: 'api' })
    oracles(state, expected)
  }
  return variants
}

/** The golden path with the step's actor swapped for the person (the fuzzy path). */
function swapActor(scenario: Scenario, index: number, actor: ActorId): Scenario {
  return {
    ...scenario,
    steps: scenario.steps.map((step, i) => (i === index ? { ...step, actor } : step)),
  }
}

/** The golden path without one step: the deviation that an engine refusal predicts. */
function withoutStep(scenario: Scenario, index: number): Scenario {
  return { ...scenario, steps: scenario.steps.filter((_, i) => i !== index) }
}
