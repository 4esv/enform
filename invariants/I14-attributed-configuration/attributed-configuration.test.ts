// Issue #20, I14, A8, AC-2, ADR 0004: the attributed configuration oracle.
//
// I14: each change that affects behavior is an attributed, versioned operation
// on the log. This includes definitions, connectors, grants, teams, templates
// and settings. AC-2 applies the same rule to grant changes. The oracle below
// states the invariant over any end state, including configuration changes that
// a story run made, so a story run can call it after its own run (MVP.md 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { CONFIG_KINDS, type ConfigChange, configOperation } from '../../engine/config.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import type { Operation } from '../../engine/operation.js'

/** A fixed Unix-millisecond time. The clock is injected, so this is the only time (I6). */
const NOW = 1_700_000_000_000

/** The principal who makes every change in these checks. A principal ID is immutable (ID-4). */
const ACTOR = 'person-8f21'

/** A deterministic byte source, so that the same run gives the same operation IDs. */
function counterBytes(): RandomBytes {
  let next = 0
  return (length) => {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      next += 1
      bytes[i] = next % 256
    }
    return bytes
  }
}

/** A fresh pair of injected sources for a configuration change (I6). */
function sources(): { readonly clock: () => number; readonly ids: () => string } {
  const random = counterBytes()
  return { clock: () => NOW, ids: () => uuidv7(NOW, random) }
}

/**
 * An end state with one configuration change of every kind, and the grant
 * change that follows it. Each change names the actor who made it (I14).
 */
function sample(): { readonly state: State; readonly next: Operation } {
  const deps = sources()
  const changes: ConfigChange[] = CONFIG_KINDS.map((kind) => ({
    kind,
    actor: ACTOR,
    payload: { name: kind },
  }))
  const state = changes.reduce(
    (acc, change) => apply(configOperation(change, deps), acc),
    emptyState
  )
  const next = configOperation(
    { kind: 'grant', actor: ACTOR, payload: { scope: 'org.grants' } },
    deps
  )
  return { state, next }
}

/**
 * The I14 oracle. Check any end state: every event that affects behavior is on
 * the log as an operation, it names the actor who made it, and its type is
 * versioned (I14, AC-2). A further configuration change appends an event and
 * leaves the past events as they were, so the engine never mutates a
 * configuration in place (I14).
 */
function assertAttributedConfiguration(
  state: State,
  next: Operation,
  append: (operation: Operation, state: State) => State = apply
): void {
  for (const event of state.log) {
    expect(event.actor, `event ${event.seq} (${event.type}) has no actor`).toBeDefined()
    expect(event.type).toMatch(/@\d+$/)
  }
  const before = [...state.log]
  const grown = append(next, state)
  expect(grown.log.slice(0, before.length)).toEqual(before)
  expect(grown.log).toHaveLength(before.length + 1)
  const appended = grown.log[grown.log.length - 1]
  expect(appended.actor, `event ${appended.seq} (${appended.type}) has no actor`).toBeDefined()
}

test.fails('#20 a configuration change is an attributed, versioned operation (I14)', () => {
  const { state, next } = sample()
  expect(state.log).toHaveLength(CONFIG_KINDS.length)
  assertAttributedConfiguration(state, next)
})

/**
 * The deliberate violation of the check above: an append that rewrites the last
 * past configuration event in place instead of adding one, so configuration is
 * mutated rather than recorded as a new operation. The oracle must fail on it,
 * and `test.fails` asserts that failure.
 */
function appendMutatingInPlace(operation: Operation, state: State): State {
  const log = state.log.map((event, index) =>
    index === state.log.length - 1
      ? { ...event, payload: operation.payload, at: operation.at }
      : event
  )
  return { applied: state.applied, log }
}

test.fails('#20 the oracle fails when a change mutates a past configuration event (I14)', () => {
  const { state, next } = sample()
  assertAttributedConfiguration(state, next, appendMutatingInPlace)
})
