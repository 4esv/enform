import type { Field } from '../../engine/definition.js'
import type { ActorId } from '../../engine/operation.js'
import {
  type ActorVariant,
  type ClockVariant,
  castFor,
  type DataVariant,
  DUPLICATE,
  type FaultVariant,
  type OfflineVariant,
  type RaceVariant,
  type Requirements,
  runActorOperator,
  runClockOperator,
  runDataOperator,
  runFaultOperator,
  runOfflineOperator,
  runOperator,
  runRaceOperator,
  runVersionOperator,
  type Versioning,
  type VersionVariant,
} from './operators.js'
import type { Scenario } from './scenario.js'

// STORIES.md, Fuzzy paths: the eight operators over one golden path. A story
// suite declares its fixture once and names each operator in a test of its
// own, so the coverage matrix reads the operator from the suite
// (tools/matrix.mjs) and a failure names the operator that found it.

/** What the operators need beside the golden path (STORIES.md, Fuzzy paths). */
export type StoryFixture = {
  readonly golden: Scenario
  /** The people of the cast, in a fixed order (I6); their grants come from the scenario. */
  readonly people: readonly ActorId[]
  /** What each step requires of its actor (I8), for the Actor operator. */
  readonly requires: Requirements
  /** The form fields of the flow (FM-1), for the Data operator. */
  readonly fields: readonly Field[]
  /** The version to publish between two steps (DF-2), for the Version operator. */
  readonly versioning: Versioning
}

/** The eight operators over a story's golden path, each one a run that returns its variants. */
export type StoryOperators = {
  readonly actor: () => Promise<readonly ActorVariant[]>
  readonly duplicate: () => Promise<void>
  readonly race: () => readonly RaceVariant[]
  readonly fault: () => readonly FaultVariant[]
  readonly offline: () => Promise<readonly OfflineVariant[]>
  readonly clock: () => Promise<readonly ClockVariant[]>
  readonly data: () => Promise<readonly DataVariant[]>
  readonly version: () => Promise<readonly VersionVariant[]>
}

/** The operators of one story (STORIES.md, Fuzzy paths). */
export function storyOperators(fixture: StoryFixture): StoryOperators {
  const { golden, people, requires, fields, versioning } = fixture
  const cast = () => castFor(golden, people)
  return {
    actor: () => runActorOperator(golden, cast(), requires),
    duplicate: () => runOperator(golden, DUPLICATE),
    race: () => runRaceOperator(golden, cast()),
    fault: () => runFaultOperator(golden),
    offline: () => runOfflineOperator(golden),
    clock: () => runClockOperator(golden),
    data: () => runDataOperator(golden, fields),
    version: () => runVersionOperator(golden, versioning),
  }
}
