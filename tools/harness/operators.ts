import { apply, emptyState, type State } from '../../engine/apply.js'
import { authorize, type Grant } from '../../engine/authorize.js'
import { type CompletionResult, completeStep } from '../../engine/concurrency.js'
import { grantsOf } from '../../engine/grants.js'
import type { ActorId, Log } from '../../engine/operation.js'
import { oracles } from './oracles.js'
import { type Deliveries, runSteps } from './runner.js'
import { type Scenario, type Step, stepOperation } from './scenario.js'

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

// Issue #32, STORIES.md Fuzzy paths: the Race operator adds a competing action
// by another person at each step of a golden path (two claims, a claim and a
// takeover, an edit and a publish). Both actions are based on the same version
// of the log, so the engine's optimistic version check (concurrency.ts, I5)
// accepts exactly one and refuses the other at once: nobody blocks, and the
// loser changes nothing. The runner generates the variants from the golden path
// in step order, then cast order, so no fuzzy test is written by hand and the
// run is deterministic (I6). The race proves the version check only; whether a
// person may act at all is the Actor operator's concern (I8).

/** One generated Race variant: one step of the golden path, raced against another person. */
export type RaceVariant = {
  readonly id: string
  readonly stepIndex: number
  /** The person who acts the step on the golden path (STORIES.md, Cast). */
  readonly actor: ActorId
  /** The other person who attempts the same step from the same version. */
  readonly competitor: ActorId
  /** The golden path with the step's actor swapped for the competitor (the predicted deviation). */
  readonly scenario: Scenario
}

/**
 * Generate one Race variant per step and per other person of the cast
 * (STORIES.md, Fuzzy paths). The competing action is the same step done by
 * another person from the same version of the log, so the engine's version
 * check decides the race (I5). The variants come in step order, then cast
 * order, so the generation is deterministic (I6).
 */
export function raceVariants(scenario: Scenario, cast: Cast): readonly RaceVariant[] {
  const people = Object.keys(cast)
  const variants: RaceVariant[] = []
  scenario.steps.forEach((step, index) => {
    for (const competitor of people) {
      if (competitor === step.actor) continue
      variants.push({
        id: `race:step${index + 1}:${competitor}`,
        stepIndex: index,
        actor: step.actor,
        competitor,
        scenario: swapActor(scenario, index, competitor),
      })
    }
  })
  return variants
}

/**
 * Run the Race operator over a golden path: every variant runs, and the oracles
 * check it (STORIES.md, Oracles). Each race runs both ways, so the golden
 * action and the competing action each win once and lose once, and exactly one
 * succeeds each time (I5). The winner continues the golden path, so the end
 * state is the golden end state when the golden action wins and the predicted
 * deviation when the competitor wins. The variants are returned, so a test can
 * count them.
 */
export function runRaceOperator(scenario: Scenario, cast: Cast): readonly RaceVariant[] {
  const variants = raceVariants(scenario, cast)
  for (const variant of variants) runRace(scenario, variant)
  return variants
}

/**
 * Run one race both ways (I5). Both actions carry the version of the log that
 * the race is based on. The first to apply wins; the second is refused at once
 * as stale and changes nothing, so exactly one succeeds. The winner continues
 * the golden path, and the oracles check the end state against the winner's
 * scenario.
 */
function runRace(scenario: Scenario, variant: RaceVariant): void {
  const index = variant.stepIndex
  const view = replay(scenario, index)
  const golden = stepOperation(scenario.steps[index], index)
  const competing = stepOperation({ ...scenario.steps[index], actor: variant.competitor }, index)

  // The golden action wins; the competing action is refused as stale (I5).
  const goldenWins = completeStep(view, index, golden)
  assertAccepted(goldenWins, variant.id, 'the golden action')
  assertRefused(completeStep(goldenWins.state, index, competing), variant.id, 'the competitor')
  oracles(continueSteps(goldenWins.state, scenario, index), scenario)

  // The competing action wins; the golden action is refused as stale (I5).
  const competitorWins = completeStep(view, index, competing)
  assertAccepted(competitorWins, variant.id, 'the competitor')
  assertRefused(completeStep(competitorWins.state, index, golden), variant.id, 'the golden action')
  oracles(continueSteps(competitorWins.state, variant.scenario, index), variant.scenario)
}

/** The state after the first `count` steps of a scenario: the shared view of a race (I4, I5). */
function replay(scenario: Scenario, count: number): State {
  let state = emptyState
  for (let i = 0; i < count; i += 1) state = apply(stepOperation(scenario.steps[i], i), state)
  return state
}

/** Apply the steps after `index`, so a winner's run reaches its golden end state (I6). */
function continueSteps(state: State, scenario: Scenario, index: number): State {
  let next = state
  for (let i = index + 1; i < scenario.steps.length; i += 1) {
    next = apply(stepOperation(scenario.steps[i], i), next)
  }
  return next
}

/** The version check accepted the winner (I5). */
function assertAccepted(result: CompletionResult, id: string, side: string): void {
  if (!result.accepted) throw new Error(`${id}: the version check refused ${side}`)
}

/** The version check refused the loser and changed nothing (I5). */
function assertRefused(result: CompletionResult, id: string, side: string): void {
  if (result.accepted) throw new Error(`${id}: the version check accepted ${side}, two succeeded`)
}

// Issue #33, STORIES.md Fuzzy paths: the Fault operator interrupts a golden
// path at each step boundary: it restarts the server, stops the realtime
// connection and stops the worker (STORIES.md, Fuzzy paths). There is no
// realtime and no worker yet, so the fault is modelled at the engine boundary
// (MVP.md I1, I3, I4): the runner rebuilds the state from the log so far (I4),
// re-applies the operations (I1) and redelivers the side effects (I3), then
// continues the golden path. The engine is fault tolerant by construction, so
// every run reaches the golden end state, and the run is deterministic (I6).
//
// This is the #33 scaffold: the test lands first and fails; the next commit
// implements the generator and the run.

/** One generated Fault variant: the step boundary where the run is interrupted. */
export type FaultVariant = {
  readonly id: string
  /** How many steps ran before the fault: the run rebuilds and redelivers here. */
  readonly boundary: number
}

/** Generate one Fault variant per step boundary (STORIES.md, Fuzzy paths). */
export function faultVariants(_scenario: Scenario): readonly FaultVariant[] {
  return []
}

/** Run the Fault operator over a golden path: fault at every boundary, check the oracles. */
export function runFaultOperator(_scenario: Scenario): readonly FaultVariant[] {
  return []
}
