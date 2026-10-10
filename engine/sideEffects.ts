// Issue #9, I3, A2, I6: idempotent side effects.
//
// I3: each side effect has a deterministic key: instance, step, rule and
// occurrence. It executes a maximum of one time, also after a retry, crash or
// redelivery. A side effect is an outbox entry (I2, SE-1), and the key comes
// from the entry alone, so the same entry always gives the same key (I6). A
// worker records the keys that it delivered and delivers only the entries
// whose key it has not delivered yet, so a redelivery of a delivered key
// executes no side effect a second time (I3). This model is pure and
// deterministic (I6): it runs no worker and reads no clock, no random source
// and no I/O of its own.

import type { Log } from './operation.js'
import { type OutboxEntry, outboxOf } from './outbox.js'

/** The payload key that carries the instance that a side effect belongs to (I3). */
const INSTANCE_KEY = 'instance'

/** The payload key that carries the step that caused a side effect (I3). */
const STEP_KEY = 'step'

/** The payload key that carries the rule that caused a side effect (I3). */
const RULE_KEY = 'rule'

/** The payload key that carries the occurrence of the rule that caused a side effect (I3). */
const OCCURRENCE_KEY = 'occurrence'

/**
 * The identity of one side effect (I3): the connector operation, its target,
 * and the instance, step, rule and occurrence that caused it. A side effect is
 * the specific effect that it is through these fields, so two entries with the
 * same identity are the same effect and share one key. The instance, step,
 * rule and occurrence live in the entry's payload (I3); the operation and the
 * target are the entry's own fields.
 */
export type SideEffectIdentity = {
  readonly operation: string
  readonly target: string
  readonly instance: string
  readonly step: string
  readonly rule: string
  readonly occurrence: string
}

/**
 * Read the identity of one side effect from the entry (I3). A payload field
 * that is absent or not a string is the empty string, so the identity is
 * always defined and the key stays deterministic (I6).
 */
export function sideEffectIdentity(entry: OutboxEntry): SideEffectIdentity {
  return {
    operation: entry.operation,
    target: entry.target,
    instance: field(entry, INSTANCE_KEY),
    step: field(entry, STEP_KEY),
    rule: field(entry, RULE_KEY),
    occurrence: field(entry, OCCURRENCE_KEY),
  }
}

/**
 * The deterministic key of one side effect (I3, I6): the identity of the entry
 * in a fixed order, encoded so that the same identity always gives the same
 * key and a different identity gives a different key. A worker stores the key
 * of each side effect that it delivered, so one key means one execution,
 * however often the worker retries or the outbox redelivers (I3).
 */
export function sideEffectKey(entry: OutboxEntry): string {
  const identity = sideEffectIdentity(entry)
  return JSON.stringify([
    identity.operation,
    identity.target,
    identity.instance,
    identity.step,
    identity.rule,
    identity.occurrence,
  ])
}

/**
 * The side effects that a worker has not delivered yet (I3): every outbox
 * entry of the log whose key the delivered set does not hold, in log order. A
 * redelivery of a key that the set already holds returns no entry, so it
 * executes no side effect a second time (I3). The function is pure and
 * deterministic (I6): the delivered set is the worker's own record, passed in,
 * and the log is the outbox, derived from the log alone (I4).
 */
export function deliver(log: Log, delivered: ReadonlySet<string>): readonly OutboxEntry[] {
  return outboxOf(log).filter((entry) => !delivered.has(sideEffectKey(entry)))
}

/** Read one string field of a side effect's payload (I3); absent or not a string is the empty string. */
function field(entry: OutboxEntry, key: string): string {
  const value = entry.payload[key]
  return typeof value === 'string' ? value : ''
}
