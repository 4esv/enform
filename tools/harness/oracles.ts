import { isDeepStrictEqual } from 'node:util'
import { apply, rebuild, type State } from '../../engine/apply.js'
import type { Operation } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { deliver, sideEffectKey } from '../../engine/sideEffects.js'
import { goldenView, type Scenario, toView } from './scenario.js'

// Issue #28, STORIES.md Test method: the oracle pipeline that every run,
// golden or generated, passes through in this order: (1) all invariants are
// true, (2) the end state is the golden end state, (3) the timeline is
// consistent. Each check throws on the first failure, so a run reports one
// clear reason. The checks are harness infrastructure, not a public surface.

/** One end state that a run produced, and the scenario that the run followed. */
export type RunResult = {
  readonly state: State
  readonly scenario: Scenario
}

/** One invariant oracle (I1 to I16). A later milestone adds a new entry to the registry. */
export type InvariantOracle = {
  readonly id: string
  readonly check: (run: RunResult) => void
}

/** The operations that a state's log records. An event carries its operation. */
function replayOperations(state: State): Operation[] {
  return state.log.map((event) => ({
    id: event.operationId,
    type: event.type,
    at: event.at,
    actor: event.actor,
    payload: event.payload,
  }))
}

/** I1: a replay of the log does not change the state, so a retry is a no-op. */
const I1: InvariantOracle = {
  id: 'I1',
  check: ({ state }) => {
    let replayed = state
    for (const operation of replayOperations(state)) replayed = apply(operation, replayed)
    if (!isDeepStrictEqual(replayed, state)) {
      throw new Error('I1: a replay of the log changed the state (idempotent operations)')
    }
  },
}

/** I3: each side effect has a deterministic key, and a redelivery of a delivered key is a no-op. */
const I3: InvariantOracle = {
  id: 'I3',
  check: ({ state }) => {
    const delivered = new Set(outboxOf(state.log).map(sideEffectKey))
    if (deliver(state.log, delivered).length > 0) {
      throw new Error('I3: a redelivery of a delivered side effect executes it again')
    }
  },
}

/** I4: the log is append-only, with a seq of 1..n, and a rebuild reproduces the state. */
const I4: InvariantOracle = {
  id: 'I4',
  check: ({ state }) => {
    for (let i = 0; i < state.log.length; i += 1) {
      if (state.log[i].seq !== i + 1) {
        throw new Error(
          `I4: event ${i + 1} has seq ${state.log[i].seq}, not ${i + 1} (append-only log)`
        )
      }
    }
    if (!isDeepStrictEqual(rebuild(state.log), state)) {
      throw new Error('I4: a rebuild of the log does not reproduce the state (append-only log)')
    }
  },
}

/** I6: the end state equals the golden end state, the deterministic engine replay. */
const I6: InvariantOracle = {
  id: 'I6',
  check: ({ state, scenario }) => {
    if (!isDeepStrictEqual(toView(state), goldenView(scenario))) {
      throw new Error('I6: the end state differs from the golden end state (determinism)')
    }
  },
}

/** I14: every behavior-affecting event, a `config.*` type, names the actor who made it. */
const I14: InvariantOracle = {
  id: 'I14',
  check: ({ state }) => {
    for (const event of state.log) {
      if (event.type.startsWith('config.') && event.actor === undefined) {
        throw new Error(
          `I14: event ${event.seq} (${event.type}) has no actor (attributed configuration)`
        )
      }
    }
  },
}

/**
 * The registered invariant oracles. A later milestone adds an invariant
 * without a change to the runner: it appends one entry here.
 */
export const INVARIANT_ORACLES: readonly InvariantOracle[] = [I1, I3, I4, I6, I14]

/** Run the three checks of #28 in order over a finished run, and throw on the first failure. */
export function oracles(state: State, scenario: Scenario): void {
  assertInvariants({ state, scenario })
  assertGoldenEndState(state, scenario)
  assertTimeline(state)
}

/** Check 1: all registered invariants are true. The check does not depend on the variation. */
function assertInvariants(run: RunResult): void {
  for (const oracle of INVARIANT_ORACLES) oracle.check(run)
}

/** Check 2: the end state is the golden end state (the deterministic engine replay). */
function assertGoldenEndState(state: State, scenario: Scenario): void {
  if (!isDeepStrictEqual(toView(state), goldenView(scenario))) {
    throw new Error('the end state is not the golden end state')
  }
}

/** Check 3: the timeline is one global order (seq 1..n), and every event is attributed. */
function assertTimeline(state: State): void {
  for (let i = 0; i < state.log.length; i += 1) {
    const event = state.log[i]
    if (event.seq !== i + 1) {
      throw new Error(`the timeline is not one global order: event ${i + 1} has seq ${event.seq}`)
    }
    if (event.actor === undefined) {
      throw new Error(`the timeline has an unattributed event: ${event.seq} (${event.type})`)
    }
  }
}
