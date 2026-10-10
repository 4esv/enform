import { isDeepStrictEqual } from 'node:util'
import { apply, rebuild, type State } from '../../engine/apply.js'
import type { DraftSession } from '../../engine/drafts.js'
import type { Operation } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { decryptDraft, isSealed, type Session } from '../../engine/session.js'
import { deliver, sideEffectKey } from '../../engine/sideEffects.js'
import { confirmedOnly, type UpdateLog } from '../../engine/updates.js'
import { goldenView, type Scenario, type StepClock, toView } from './scenario.js'

// Issue #28, STORIES.md Test method: the oracle pipeline that every run,
// golden or generated, passes through in this order: (1) all invariants are
// true, (2) the end state is the golden end state, (3) the timeline is
// consistent. Each check throws on the first failure, so a run reports one
// clear reason. The checks are harness infrastructure, not a public surface.

/** One end state that a run produced, and the scenario that the run followed. */
export type RunResult = {
  readonly state: State
  readonly scenario: Scenario
  /** The injected step clock of the run (I6). Absent means the golden step clock. */
  readonly clock?: StepClock
  /**
   * The local-first draft session of the run (I15). Absent means the run holds
   * no drafts, which is every run before the realtime path (RT-3).
   */
  readonly drafts?: DraftSession
  /**
   * The optimistic updates of the run (I16). Absent means the run holds no
   * updates, which is every run before the realtime path (RT-3).
   */
  readonly updates?: UpdateLog
  /**
   * The encrypted local draft session of the run (I11). Absent means the run
   * holds no session, which is every run before the realtime path (RT-3).
   */
  readonly session?: Session
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

/** I6: the end state equals the golden end state, the deterministic replay under the run's clock. */
const I6: InvariantOracle = {
  id: 'I6',
  check: ({ state, scenario, clock }) => {
    if (!isDeepStrictEqual(toView(state), goldenView(scenario, clock))) {
      throw new Error('I6: the end state differs from the golden end state (determinism)')
    }
  },
}

/**
 * I11: the stored drafts are ciphertext under the session key, never plaintext,
 * so an unencrypted local copy is visible; and a session that sign-out or the
 * idle timeout destroyed holds no key and no ciphertext, so its drafts are
 * unrecoverable. A run before the realtime path (RT-3) carries no session, so
 * the check is empty until a run supplies one.
 */
const I11: InvariantOracle = {
  id: 'I11',
  check: ({ session }) => {
    if (session === undefined) return
    for (const stored of session.drafts) {
      if (!isSealed(stored.ciphertext)) {
        throw new Error(`I11: draft ${stored.id} is stored without encryption`)
      }
      if (session.key === undefined) {
        throw new Error(`I11: draft ${stored.id} is stored without a session key`)
      }
      const plaintext = decryptDraft(stored, session.key)
      if (stored.ciphertext === plaintext || stored.ciphertext.includes(plaintext)) {
        throw new Error(`I11: draft ${stored.id} stores its plaintext`)
      }
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
 * I15: every edit that the device saved is synced or still recoverable, so a
 * saved edit is released only by a deliberate discard, and every held draft
 * shows the difference between "Saved on this device" and "Synced". A run
 * before the realtime path (RT-3) carries no drafts, so the check is empty
 * until a run supplies them.
 */
const I15: InvariantOracle = {
  id: 'I15',
  check: ({ drafts }) => {
    if (drafts === undefined) return
    for (const saved of drafts.saved) {
      const held = drafts.held.find((draft) => draft.id === saved.id)
      if (held === undefined && !drafts.discarded.includes(saved.id)) {
        throw new Error(
          `I15: the saved edit on draft ${saved.id} disappeared without a sync or a deliberate discard`
        )
      }
    }
    for (const draft of drafts.held) {
      if (draft.state !== 'saved' && draft.state !== 'synced') {
        throw new Error(`I15: draft ${draft.id} does not show whether it is saved or synced`)
      }
      if (draft.state === 'saved' && Object.keys(draft.edit).length === 0) {
        throw new Error(`I15: the saved edit on draft ${draft.id} is not recoverable`)
      }
    }
  },
}

/**
 * I16: the confirmed set that the interface shows holds no pending update, so
 * it never shows an unconfirmed state as confirmed, and every update shows
 * whether it is pending or confirmed. A run before the realtime path (RT-3)
 * carries no updates, so the check is empty until a run supplies them.
 */
const I16: InvariantOracle = {
  id: 'I16',
  check: ({ updates }) => {
    if (updates === undefined) return
    const acknowledged = new Set(
      updates.filter((update) => update.state === 'confirmed').map((update) => update.id)
    )
    for (const update of updates) {
      if (update.state !== 'pending' && update.state !== 'confirmed') {
        throw new Error(`I16: update ${update.id} does not show whether it is pending or confirmed`)
      }
    }
    for (const update of confirmedOnly(updates)) {
      if (!acknowledged.has(update.id)) {
        throw new Error(
          `I16: the interface shows update ${update.id} as confirmed while it is pending`
        )
      }
    }
  },
}

/**
 * The registered invariant oracles. A later milestone adds an invariant
 * without a change to the runner: it appends one entry here.
 */
export const INVARIANT_ORACLES: readonly InvariantOracle[] = [I1, I3, I4, I6, I11, I14, I15, I16]

/**
 * Run the three checks of #28 in order over a finished run, and throw on the
 * first failure. The step clock is the injected source of the run (I6): absent
 * it is the golden step clock, and a caller that moves the clock (the Clock
 * operator) passes the moved clock so that the golden end state and the
 * timeline are read under the same clock as the run.
 */
export function oracles(
  state: State,
  scenario: Scenario,
  clock?: StepClock,
  drafts?: DraftSession,
  updates?: UpdateLog,
  session?: Session
): void {
  assertInvariants({ state, scenario, clock, drafts, updates, session })
  assertGoldenEndState(state, scenario, clock)
  assertTimeline(state, clock)
}

/** Check 1: all registered invariants are true. The check does not depend on the variation. */
function assertInvariants(run: RunResult): void {
  for (const oracle of INVARIANT_ORACLES) oracle.check(run)
}

/** Check 2: the end state is the golden end state (the deterministic replay under the run's clock). */
function assertGoldenEndState(state: State, scenario: Scenario, clock?: StepClock): void {
  if (!isDeepStrictEqual(toView(state), goldenView(scenario, clock))) {
    throw new Error('the end state is not the golden end state')
  }
}

/**
 * Check 3: the timeline is one global order (seq 1..n), and every event is
 * attributed. A run with an injected clock also has its `at` values checked
 * against the clock's readings (I6): a moved clock moves `at` and nothing else.
 */
function assertTimeline(state: State, clock?: StepClock): void {
  for (let i = 0; i < state.log.length; i += 1) {
    const event = state.log[i]
    if (event.seq !== i + 1) {
      throw new Error(`the timeline is not one global order: event ${i + 1} has seq ${event.seq}`)
    }
    if (event.actor === undefined) {
      throw new Error(`the timeline has an unattributed event: ${event.seq} (${event.type})`)
    }
    if (clock !== undefined && event.at !== clock(i)) {
      throw new Error(
        `the timeline does not follow the injected clock: event ${event.seq} is at ${event.at}, not ${clock(i)} (I6)`
      )
    }
  }
}
