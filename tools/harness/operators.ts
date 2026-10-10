import { isDeepStrictEqual } from 'node:util'
import { apply, emptyState, rebuild, type State } from '../../engine/apply.js'
import { authorize, type Grant } from '../../engine/authorize.js'
import { type CompletionResult, completeStep } from '../../engine/concurrency.js'
import {
  DEFINITION_CHANGED,
  type Field,
  type FlowDefinition,
  type JsonValue,
} from '../../engine/definition.js'
import { type FieldError, validateField } from '../../engine/fields.js'
import { DEFINITION_PUBLISHED, type FlowVersion } from '../../engine/flow.js'
import { grantsOf } from '../../engine/grants.js'
import { contentHash, createInstance } from '../../engine/instance.js'
import type { ActorId, Log, Operation } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { deliver, sideEffectKey } from '../../engine/sideEffects.js'
import { oracles } from './oracles.js'
import { type Deliveries, runSteps } from './runner.js'
import {
  goldenClock,
  goldenView,
  type Scenario,
  type StateView,
  type Step,
  type StepClock,
  stepOperation,
  toView,
} from './scenario.js'

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
// continues the golden path. The engine is fault tolerant by construction: the
// rebuild reproduces the state, a re-apply is a no-op, and a redelivery fires
// at most once, so every run reaches the golden end state. The runner generates
// the variants in step order, so no fuzzy test is written by hand and the run
// is deterministic (I6). A side effect is part of its operation's payload (I2),
// so a rebuild and a re-apply read the same outbox as the prefix did.

/** One generated Fault variant: the step boundary where the run is interrupted. */
export type FaultVariant = {
  readonly id: string
  /** How many steps ran before the fault: the run rebuilds and redelivers here. */
  readonly boundary: number
}

/**
 * Generate one Fault variant per step boundary (STORIES.md, Fuzzy paths). A
 * boundary is the point after one step, so a golden path of n steps gives n
 * variants, in step order, so the generation is deterministic (I6).
 */
export function faultVariants(scenario: Scenario): readonly FaultVariant[] {
  const variants: FaultVariant[] = []
  for (let boundary = 1; boundary <= scenario.steps.length; boundary += 1) {
    variants.push({ id: `fault:after-step${boundary}`, boundary })
  }
  return variants
}

/**
 * Run the Fault operator over a golden path: fault at every boundary, and the
 * oracles check each run (STORIES.md, Oracles). The fault is three failures at
 * once, modelled at the engine boundary: restart the server (rebuild the state
 * from the log, I4), stop the realtime connection (re-apply the prefix, I1) and
 * stop the worker (redeliver the side effects, I3). Each is a no-op on an
 * engine that is fault tolerant by construction, so the run continues to the
 * golden end state. The variants are returned, so a test can count them.
 */
export function runFaultOperator(scenario: Scenario): readonly FaultVariant[] {
  const variants = faultVariants(scenario)
  for (const variant of variants) runFault(scenario, variant)
  return variants
}

/**
 * Run one fault at one step boundary. The prefix runs first, then the fault,
 * then the rest of the golden path. The fault leaves the state equal to the
 * state that the prefix produced (I1, I3, I4), so the oracles see the golden
 * end state.
 */
function runFault(scenario: Scenario, variant: FaultVariant): void {
  const prefix: Operation[] = []
  let state = emptyState
  for (let i = 0; i < variant.boundary; i += 1) {
    const operation = stepOperation(scenario.steps[i], i)
    prefix.push(operation)
    state = apply(operation, state)
  }

  // Restart the server (I4): rebuild the derived state from the log alone.
  const rebuilt = rebuild(state.log)
  if (!isDeepStrictEqual(rebuilt, state)) {
    throw new Error(`${variant.id}: the rebuild did not reproduce the state (I4)`)
  }

  // Stop the realtime connection (I1): re-apply the prefix. Every operation ID
  // is already applied, so every re-apply returns the same state.
  let reapplied = rebuilt
  for (const operation of prefix) reapplied = apply(operation, reapplied)
  if (!isDeepStrictEqual(reapplied, state)) {
    throw new Error(`${variant.id}: the re-apply changed the state (I1)`)
  }

  // Stop the worker (I3): redeliver the side effects. A worker that already
  // delivered the prefix's side effects delivers no entry a second time.
  const delivered = new Set(outboxOf(reapplied.log).map(sideEffectKey))
  if (deliver(reapplied.log, delivered).length > 0) {
    throw new Error(`${variant.id}: the redelivery executed a side effect again (I3)`)
  }

  // Continue the golden path from the rebuilt state, and check the oracles.
  let end = reapplied
  for (let i = variant.boundary; i < scenario.steps.length; i += 1) {
    end = apply(stepOperation(scenario.steps[i], i), end)
  }
  oracles(end, scenario)
}

// Issue #35, STORIES.md Fuzzy paths: the Clock operator moves the injected
// clock forward, back or skews it at each step of a golden path, near
// deadlines and idle limits. The engine reads no clock of its own (I6): the
// clock is a source of a run, so a moved clock changes the `at` of the
// operations and nothing else. The same steps give the same state under any
// clock, and the timeline's `at` values follow the injected clock. The runner
// generates the variants in step order, then move order, so no fuzzy test is
// written by hand and the run is deterministic (I6).

/** One clock move of the Clock operator (STORIES.md, Fuzzy paths). */
export type ClockMove = 'forward' | 'back' | 'skew'

/** The moves of the Clock operator, in generation order (I6). */
const CLOCK_MOVES: readonly ClockMove[] = ['forward', 'back', 'skew']

/**
 * How far a moved clock jumps past a deadline and an idle limit (STORIES.md,
 * Fuzzy paths), in the unit of the step clock. The engine measures idle time
 * and deadlines in milliseconds (takeover.ts, reminders.ts).
 */
const IDLE_LIMIT = 60_000

/** How far a skewed clock drifts off the step time: a fraction of a step, so it stays a skew. */
const SKEW = 0.5

/**
 * The injected clock of one variant (I6): the golden step clock, moved at the
 * variant's step and left in force after it. A forward or back move jumps by
 * an idle limit; a skew drifts by a fraction of a step.
 */
function movedClock(move: ClockMove, movedIndex: number): StepClock {
  const shift = move === 'forward' ? IDLE_LIMIT : move === 'back' ? -IDLE_LIMIT : SKEW
  return (index) => goldenClock(index) + (index >= movedIndex ? shift : 0)
}

/** One generated Clock variant: one step of the golden path, with the clock moved there. */
export type ClockVariant = {
  readonly id: string
  readonly stepIndex: number
  readonly move: ClockMove
  /** The injected clock of the variant (I6): it gives the time of each step. */
  readonly clock: StepClock
}

/**
 * Generate one Clock variant per step and per move (STORIES.md, Fuzzy paths).
 * A variant moves the clock at one step, so the golden path of n steps gives
 * 3n variants, in step order, then move order, so the generation is
 * deterministic (I6).
 */
export function clockVariants(scenario: Scenario): readonly ClockVariant[] {
  const variants: ClockVariant[] = []
  scenario.steps.forEach((_step, index) => {
    for (const move of CLOCK_MOVES) {
      variants.push({
        id: `clock:${move}:step${index + 1}`,
        stepIndex: index,
        move,
        clock: movedClock(move, index),
      })
    }
  })
  return variants
}

/**
 * Run the Clock operator over a golden path: every variant runs in api mode
 * under its moved clock, and the oracles check it (STORIES.md, Oracles, I6).
 * The clock is the only source that moves, so a moved clock shifts the `at` of
 * the operations but not the log's shape: the end state equals the golden end
 * state in everything but `at`, and the timeline's `at` values are the
 * clock's readings. The variants are returned, so a test can count them.
 */
export async function runClockOperator(scenario: Scenario): Promise<readonly ClockVariant[]> {
  const variants = clockVariants(scenario)
  const goldenShape = logShape(goldenView(scenario))
  for (const variant of variants) {
    const { state } = await runSteps(scenario, { mode: 'api', clock: variant.clock })
    oracles(state, scenario, variant.clock)
    if (!isDeepStrictEqual(logShape(toView(state)), goldenShape)) {
      throw new Error(`${variant.id}: the moved clock changed the state, not only the times (I6)`)
    }
  }
  return variants
}

/** The log shape of a state view without the clock's `at` (I6): a moved clock must not change it. */
function logShape(view: StateView): readonly unknown[] {
  return view.log.map((event) => ({
    seq: event.seq,
    operationId: event.operationId,
    type: event.type,
    actor: event.actor,
    payload: event.payload,
  }))
}

// Issue #37, STORIES.md Fuzzy paths: the Version operator publishes a new
// definition version between two steps of a golden path. A published version
// is immutable and carries a content hash (DF-2), and an instance stays on the
// version that it started on (DF-2). The engine stamps each instance with the
// hash of the definition that it started on and never moves it (instance.ts),
// so a publication between two steps leaves an instance in progress on its
// version, gives the new version a different hash, and records the change on
// the log, which the timeline projects (I4). The runner generates one variant
// per step boundary from the golden path, so no fuzzy test is written by hand
// and the run is deterministic (I6). The variant's log is the golden path with
// the change and its publication inserted; the harness checks the invariants,
// the variant's golden end state and the timeline, and never re-derives the
// flow from the log.

/**
 * How the Version operator publishes a new definition version between two
 * steps (STORIES.md, Fuzzy paths): the actor who publishes, the flow slug, the
 * new definition to publish, and the definition that an instance in progress
 * started on.
 */
export type Versioning = {
  /** The actor who pushes and publishes the new version (I14). */
  readonly actor: ActorId
  /** The slug of the flow that the publication names (VT-6). */
  readonly slug: string
  /** The new definition that the operator pushes and publishes (DF-4). */
  readonly definition: FlowDefinition
  /** The definition that an instance in progress started on, before the publication (DF-2). */
  readonly started: FlowDefinition
}

/** One generated Version variant: the step boundary where a new version is published. */
export type VersionVariant = {
  readonly id: string
  /** How many golden steps run before the publication (1 to n). */
  readonly boundary: number
  /** The golden path with the definition change and its publication inserted at the boundary. */
  readonly scenario: Scenario
  /** The definition that an instance in progress started on (DF-2). */
  readonly started: FlowDefinition
  /** The version that the inserted publication creates (DF-2, VT-6). */
  readonly published: FlowVersion
}

/**
 * Generate one Version variant per step boundary (STORIES.md, Fuzzy paths). A
 * boundary is the point after one step, so a golden path of n steps gives n
 * variants, in step order, so the generation is deterministic (I6). Each
 * variant inserts a definition change and the publication that freezes it
 * between the boundary and the next step; the publication is the next version
 * after the ones that the golden path published before the boundary.
 */
export function versionVariants(
  scenario: Scenario,
  versioning: Versioning
): readonly VersionVariant[] {
  const variants: VersionVariant[] = []
  for (let boundary = 1; boundary <= scenario.steps.length; boundary += 1) {
    const version = publicationsBefore(scenario, boundary) + 1
    const published: FlowVersion = {
      version,
      contentHash: contentHash(versioning.definition),
      definition: versioning.definition,
    }
    variants.push({
      id: `version:after-step${boundary}`,
      boundary,
      scenario: insertVersion(scenario, boundary, versioning, published),
      started: versioning.started,
      published,
    })
  }
  return variants
}

/**
 * Run the Version operator over a golden path: publish a new version at every
 * boundary, and the oracles check each run (STORIES.md, Oracles). A published
 * version is immutable (DF-2), so an instance that already started keeps its
 * `definitionVersion`, the new version has a different content hash, and the
 * timeline records the publication. The variants are returned, so a test can
 * count them.
 */
export async function runVersionOperator(
  scenario: Scenario,
  versioning: Versioning
): Promise<readonly VersionVariant[]> {
  const variants = versionVariants(scenario, versioning)
  for (const variant of variants) {
    const { state } = await runSteps(variant.scenario, { mode: 'api' })
    oracles(state, variant.scenario)
    assertVersionPinned(variant, state)
  }
  return variants
}

/**
 * DF-2: an instance already in progress stays on the version that it started
 * on. The engine stamps the instance with the content hash of its definition
 * (instance.ts), a publication creates a version with a different hash, and the
 * log records the publication, which the timeline projects (I4). The check
 * throws the first time a variant breaks one of the three.
 */
function assertVersionPinned(variant: VersionVariant, state: State): void {
  const started = contentHash(variant.started)
  const instance = createInstance(variant.started, [])
  if (instance.definitionVersion !== started) {
    throw new Error(`${variant.id}: the instance did not start on its version (DF-2)`)
  }
  if (variant.published.contentHash !== contentHash(variant.published.definition)) {
    throw new Error(`${variant.id}: the version does not match its definition (DF-2)`)
  }
  if (variant.published.contentHash === started) {
    throw new Error(`${variant.id}: the new version has the same content hash (DF-2)`)
  }
  const recorded = state.log.some(
    (event) =>
      event.type === DEFINITION_PUBLISHED &&
      event.payload.contentHash === variant.published.contentHash
  )
  if (!recorded) {
    throw new Error(`${variant.id}: the timeline does not record the new version (DF-2)`)
  }
}

/** The golden path with the definition change and its publication inserted after `boundary` steps. */
function insertVersion(
  scenario: Scenario,
  boundary: number,
  versioning: Versioning,
  published: FlowVersion
): Scenario {
  const change: Step = {
    actor: versioning.actor,
    type: DEFINITION_CHANGED,
    payload: versioning.definition,
  }
  const publication: Step = {
    actor: versioning.actor,
    type: DEFINITION_PUBLISHED,
    payload: {
      slug: versioning.slug,
      version: published.version,
      contentHash: published.contentHash,
      definition: published.definition,
    },
  }
  return {
    ...scenario,
    steps: [
      ...scenario.steps.slice(0, boundary),
      change,
      publication,
      ...scenario.steps.slice(boundary),
    ],
  }
}

/** How many versions the golden path published before a boundary (DF-2). */
function publicationsBefore(scenario: Scenario, boundary: number): number {
  let count = 0
  for (let i = 0; i < boundary; i += 1) {
    if (scenario.steps[i].type === DEFINITION_PUBLISHED) count += 1
  }
  return count
}

// Issue #36, STORIES.md Fuzzy paths: the Data operator generates valid and
// invalid form data from the flow schema, with property-based generation. The
// golden path of a field-bearing flow carries the form data on its submission
// step, in the step payload's `data` record. For each field of the flow's steps
// the operator generates one value that the field's control accepts and one
// that it refuses, from the control type's constraints (FM-1). The engine's
// validator (validateField, FM-4) is the oracle: an accepted value passes and
// the run reaches the variant's golden end state; a refused value fails
// validation with the field path, so the submission does not land and the run
// deviates by exactly that step. The generator is deterministic (I6): it reads
// no clock and no random source, and the variants come in field order, valid
// before invalid. The engine records no form data yet, so the operator models
// the FM-4 boundary: it checks the value with the engine's validator at the
// submission step and predicts the deviation.

/**
 * One value that a field's control can receive (FM-1): a JSON value, or no
 * value at all (a static control takes no value).
 */
export type FormValue = JsonValue | undefined

/** One generated Data variant: one field of the flow, with one submitted value (FM-1). */
export type DataVariant = {
  readonly id: string
  /** The field whose value the variant submits (FM-1). */
  readonly field: Field
  /** The value that the variant submits (FM-1). */
  readonly value: FormValue
  /** The engine's prediction (FM-4): the control accepts the value, or it refuses it. */
  readonly expected: 'accepted' | 'refused'
  /** The predicted deviation of a refused value: the failure that names the field path (FM-1). */
  readonly deviation?: FieldError
  /** The golden path with the field's value injected into the submission step. */
  readonly scenario: Scenario
}

/**
 * Generate one valid and one invalid variant per field (STORIES.md, Fuzzy
 * paths). The valid value fits the field's control and the invalid value does
 * not, both from the control type's constraints (FM-1). The variants come in
 * field order, valid before invalid, so the generation is deterministic (I6).
 * The value goes into the submission step, the step of the golden path that
 * carries the form data (FM-4).
 */
export function dataVariants(scenario: Scenario, fields: readonly Field[]): readonly DataVariant[] {
  const index = dataStepIndex(scenario)
  const variants: DataVariant[] = []
  for (const field of fields) {
    const valid = validValue(field)
    variants.push({
      id: `data:valid:${field.key}`,
      field,
      value: valid,
      expected: 'accepted',
      scenario: withData(scenario, index, field.key, valid),
    })
    const invalid = invalidValue(field)
    variants.push({
      id: `data:invalid:${field.key}`,
      field,
      value: invalid,
      expected: 'refused',
      deviation: validateField(field, invalid),
      scenario: withData(scenario, index, field.key, invalid),
    })
  }
  return variants
}

/**
 * Run the Data operator over a golden path: every variant runs, and the
 * oracles check it (STORIES.md, Oracles). An accepted value passes the
 * engine's validator (FM-4), so the submission lands and the run reaches the
 * variant's golden end state. A refused value fails validation with the field
 * path (FM-1), so the submission does not land and the run deviates by exactly
 * the submission step, the predicted deviation. The variants are returned, so
 * a test can count them.
 */
export async function runDataOperator(
  scenario: Scenario,
  fields: readonly Field[]
): Promise<readonly DataVariant[]> {
  const variants = dataVariants(scenario, fields)
  const index = dataStepIndex(scenario)
  for (const variant of variants) {
    const error = validateField(variant.field, variant.value)
    if (variant.expected === 'accepted') {
      if (error !== undefined) {
        throw new Error(`${variant.id}: the generated value is not accepted (FM-1, FM-4)`)
      }
      const { state } = await runSteps(variant.scenario, { mode: 'api' })
      oracles(state, variant.scenario)
    } else {
      if (error === undefined || error.path !== variant.field.key) {
        throw new Error(`${variant.id}: the value is not refused with its field path (FM-4)`)
      }
      const deviation = withoutStep(variant.scenario, index)
      const { state } = await runSteps(deviation, { mode: 'api' })
      oracles(state, deviation)
    }
  }
  return variants
}

/** The index of the golden step that carries the form data (FM-4): the submission step. */
function dataStepIndex(scenario: Scenario): number {
  const index = scenario.steps.findIndex((step) => isRecord(step.payload.data))
  if (index === -1) {
    throw new Error('data operator: the scenario has no step that carries form data (FM-4)')
  }
  return index
}

/** The golden path with one value injected into the data step's form data (FM-1). */
function withData(scenario: Scenario, index: number, key: string, value: FormValue): Scenario {
  return {
    ...scenario,
    steps: scenario.steps.map((step, i) => {
      if (i !== index) return step
      const data = isRecord(step.payload.data) ? step.payload.data : {}
      // A static control takes no value (FM-1), so it adds no payload entry;
      // the run and its golden replay must stay equal through JSON.
      if (value === undefined) return step
      return { ...step, payload: { ...step.payload, data: { ...data, [key]: value } } }
    }),
  }
}

/** A value that a field's control accepts (FM-1), from the control type alone (I6). */
function validValue(field: Field): FormValue {
  const option = field.options?.[0]
  switch (field.control) {
    case 'text':
    case 'long-text':
      return 'sample'
    case 'number':
    case 'money':
      return 1
    case 'date':
      return '2026-01-01'
    case 'select':
    case 'radio':
      return option
    case 'multi-select':
      return option === undefined ? [] : [option]
    case 'checkbox':
      return true
    case 'yes-no':
      return 'yes'
    case 'email':
      return 'sam@example.org'
    case 'phone':
      return '+1 555 0100'
    case 'file':
      return 'file:sample'
    case 'user':
      return 'user:sam'
    case 'static':
      return undefined
    case 'repeating':
      return [{ key: 'value' }]
  }
}

/** A value that a field's control refuses (FM-1), from the control type alone (I6). */
function invalidValue(field: Field): FormValue {
  switch (field.control) {
    case 'text':
    case 'long-text':
      return 42
    case 'number':
    case 'money':
      return 'not a number'
    case 'date':
      return '01/01/2026'
    case 'select':
    case 'radio':
      return 'not-an-option'
    case 'multi-select':
      return 'not a list'
    case 'checkbox':
      return 'true'
    case 'yes-no':
      return 'maybe'
    case 'email':
      return 'not-an-email'
    case 'phone':
      return 'not a phone'
    case 'file':
    case 'user':
      return ''
    case 'static':
      return 'text'
    case 'repeating':
      return 'not a list'
  }
}

/** A JSON object: not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
