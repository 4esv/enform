// Issue #9, I3, A2, I6: the idempotent side-effects oracle.
//
// I3: each side effect has a deterministic key: instance, step, rule and
// occurrence. It executes a maximum of one time, also after a retry, crash or
// redelivery. A side effect is an outbox entry (I2, SE-1), and the key comes
// from the entry alone, so the same entry always gives the same key (I6). A
// worker records the keys that it delivered and delivers only the entries
// whose key it has not delivered yet, so a redelivery of a delivered key
// executes no side effect a second time. The oracle below states that as a
// check over any end state. A story run can call it after its own run (MVP.md
// 11.4).

import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../../engine/apply.js'
import { type RandomBytes, uuidv7 } from '../../engine/id.js'
import type { Log } from '../../engine/operation.js'
import { createOutboxOperation, type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import { deliver, sideEffectIdentity, sideEffectKey } from '../../engine/sideEffects.js'

/** A fixed Unix-millisecond time. The clock is injected, so this is the only time (I6). */
const NOW = 1_700_000_000_000

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

/** The canonical identity string of a side effect, from the entry's identity fields (I3). */
function identityOf(entry: OutboxEntry): string {
  return JSON.stringify(sideEffectIdentity(entry))
}

/** One reminder that a rule sends (SE-1, SE-3): the instance, step, rule and occurrence (I3). */
const REMINDER: OutboxEntry = {
  operation: 'send-reminder',
  target: 'connector-smtp',
  payload: {
    instance: 'instance-1',
    step: 'approve',
    rule: 'remind',
    occurrence: '2026-10-10T09:00:00Z',
  },
}

/** The same rule at its next occurrence: a second side effect, with its own key (I3). */
const NEXT_REMINDER: OutboxEntry = {
  operation: 'send-reminder',
  target: 'connector-smtp',
  payload: {
    instance: 'instance-1',
    step: 'approve',
    rule: 'remind',
    occurrence: '2026-10-10T17:00:00Z',
  },
}

/** An end state whose log carries the two occurrences of one reminder rule. */
function sample(): State {
  const random = counterBytes()
  const deps = { clock: () => NOW, ids: () => uuidv7(NOW, random) }
  const operations = [
    createOutboxOperation('reminder.due@1', {}, [REMINDER], deps),
    createOutboxOperation('reminder.due@1', {}, [NEXT_REMINDER], deps),
  ]
  return operations.reduce((state, operation) => apply(operation, state), emptyState)
}

/**
 * The I3 oracle. Check any end state: every side effect that its log carries
 * has a deterministic key that follows the entry's identity (the instance,
 * step, rule and occurrence), and a worker that records the keys that it
 * delivered gets no side effect again on a redelivery (I3). It takes any end
 * state, not only a fresh one, so a story run can call it after its own run
 * (MVP.md 11.4). `key` and `pending` are injectable, so a check states I3 as a
 * mutation: a key that ignores an occurrence, or a worker that executes a
 * delivered key again, must fail the oracle.
 */
function assertIdempotentSideEffects(
  state: State,
  key: (entry: OutboxEntry) => string = sideEffectKey,
  pending: (log: Log, delivered: ReadonlySet<string>) => readonly OutboxEntry[] = deliver
): void {
  const entries = outboxOf(state.log)
  for (let i = 0; i < entries.length; i += 1) {
    expect(key(entries[i]), 'the key of a side effect is not deterministic').toBe(key(entries[i]))
    for (let j = i + 1; j < entries.length; j += 1) {
      const sameKey = key(entries[i]) === key(entries[j])
      const sameIdentity = identityOf(entries[i]) === identityOf(entries[j])
      expect(sameKey, 'the key does not follow the identity of the side effect (I3)').toBe(
        sameIdentity
      )
    }
  }
  expect(
    pending(state.log, new Set()),
    'a worker drops a side effect that it never delivered (I3)'
  ).toEqual(entries)
  const delivered = new Set(entries.map((entry) => key(entry)))
  expect(
    pending(state.log, delivered),
    'a redelivery of a delivered key executes a side effect a second time (I3)'
  ).toEqual([])
}

test('#9 delivering a log twice executes each side effect once (I3)', () => {
  const state = sample()
  expect(outboxOf(state.log)).toEqual([REMINDER, NEXT_REMINDER])
  assertIdempotentSideEffects(state)
})

/**
 * The deliberate violation of the key: a key that ignores the occurrence, so
 * the second occurrence of a rule shares the key of the first and a worker
 * drops it. The oracle must fail on it, and `test.fails` asserts that failure
 * (I3).
 */
function keyWithoutOccurrence(entry: OutboxEntry): string {
  const identity = sideEffectIdentity(entry)
  return JSON.stringify([
    identity.operation,
    identity.target,
    identity.instance,
    identity.step,
    identity.rule,
  ])
}

test.fails('#9 the oracle fails on a key that ignores an occurrence (I3)', () => {
  assertIdempotentSideEffects(sample(), keyWithoutOccurrence)
})

/**
 * The deliberate violation of the delivery: a worker that ignores the keys
 * that it delivered, so a redelivery executes a side effect again. The oracle
 * must fail on it, and `test.fails` asserts that failure (I3).
 */
function deliverWithoutRecording(log: Log): readonly OutboxEntry[] {
  return outboxOf(log)
}

test.fails('#9 the oracle fails on a redelivery that executes again (I3)', () => {
  assertIdempotentSideEffects(sample(), sideEffectKey, deliverWithoutRecording)
})
