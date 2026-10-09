// Issue #53, S16, WF-5, A2, D6, I2, I4, I6, I13, I14: undo a mistake with a
// compensating event.
//
// S16: Lee approved the wrong request. An undo is a compensating event (WF-5,
// D6, A2): the engine appends an `event.undone@1` event and never rewrites or
// deletes the event that it undoes (I4), so the log keeps both events and the
// original one stays attributed (I14). The engine refuses an undo of an event
// that the flow has moved past, and gives the reason (S16, WF-5): the point
// where a flow becomes final is a later schema change, so the engine takes it
// as an injected predicate, as S10 takes the idle timeout and S13 the undo
// period. A side effect that already occurred is never reversed (A2): the
// engine marks every side effect of the undone event that a recorded connector
// call already ran as "Already sent", and the notification to the people that
// it reached rides in the same operation as the compensating event (I2). The
// functions are pure and deterministic (I6): they read no clock, no random
// source and no I/O of their own, and the injected operation sources come in as
// arguments.

import type { ConnectorCall } from './instance.js'
import type { ActorId, Event, Log, Operation, OperationDeps } from './operation.js'
import { createOutboxOperation, type OutboxEntry, outboxOfEvent } from './outbox.js'
import { EMAIL_CONNECTOR } from './submission.js'

/** The versioned event type of an undo (S16, WF-5, D6). */
export const EVENT_UNDONE = 'event.undone@1'

/** The connector operation that tells the affected people that the undo happened (S16, SE-2). */
export const UNDO_NOTIFICATION = 'send-undone'

/**
 * The marker of a side effect that already occurred (S16, A2). The undo does
 * not reverse it, and the timeline shows this status.
 */
export const ALREADY_SENT = 'Already sent'

/**
 * The outcome of a connector call that already ran (I13, S16). A side effect
 * whose operation a call recorded with this outcome already occurred, so an
 * undo marks it and does not reverse it (A2).
 */
export const SENT_OUTCOME = 'sent'

/** The reserved payload key that carries the side effects that already occurred (S16, A2). */
const ALREADY_SENT_KEY = 'alreadySent'

/** The reserved payload key that carries the people that the undo notified (S16). */
const NOTIFIED_KEY = 'notified'

/**
 * The final point of a flow (S16, WF-5). A later flow setting states where a
 * flow becomes final, so the engine takes it as an injected predicate, as S10
 * takes the idle timeout and S13 the undo period. It reads the event and the
 * log (I4) and answers with the reason that the event sits past the point that
 * the flow marks final, or `undefined` when the event is still undoable.
 */
export type FinalPoint = (event: Event, log: Log) => string | undefined

/** What an undo needs beyond the id of the event, the reason, the log and the injected sources (S16). */
export type UndoOptions = {
  /** Who undoes the event (I14, S16). An undo of a mistake is an attributed change. */
  readonly actor: ActorId
  /** The final point of the flow (S16, WF-5); absent when the flow marks no point final. */
  readonly finalPoint?: FinalPoint
  /**
   * The connector calls that the instance recorded (I13, A2). The engine marks
   * each side effect of the undone event whose operation a call already ran
   * with `SENT_OUTCOME` as "Already sent", and notifies the people that it
   * reached. Absent means that the instance recorded no call, so no side effect
   * of the undone event already occurred.
   */
  readonly calls?: readonly ConnectorCall[]
}

/**
 * One side effect of an undone event that already occurred (S16, A2). It is
 * the side effect that the engine does not reverse, with the status that the
 * timeline shows for it.
 */
export type AlreadySentEffect = {
  /** The connector operation that already ran (I13). */
  readonly operation: string
  /** The connector or resource that ran it (SE-1). */
  readonly target: string
  /** The person that the side effect reached (S16); absent when its payload names nobody. */
  readonly to?: ActorId
  /** The status that the undo gives it (S16, A2): it already occurred and stays. */
  readonly status: typeof ALREADY_SENT
}

/**
 * The result of an undo (S16, WF-5, I4). `accepted` says whether the engine
 * appended the compensating event. When it did not, `operation`, `outbox`,
 * `alreadySent` and `notified` are absent, and `reason` says why: the log holds
 * no such event, or the flow moved past the point that it marks final (S16,
 * WF-5).
 */
export type UndoResult = {
  readonly accepted: boolean
  /** The compensating operation that records the undo (I4); absent when the engine refused. */
  readonly operation?: Operation
  /** The notification to each affected person (I2, SE-2); absent when the engine refused. */
  readonly outbox?: readonly OutboxEntry[]
  /** The side effects of the undone event that already occurred (A2); absent when the engine refused. */
  readonly alreadySent?: readonly AlreadySentEffect[]
  /** The people that the undo notified (S16); absent when the engine refused. */
  readonly notified?: readonly ActorId[]
  /** Why the engine refused the undo (S16, WF-5); absent when it accepted. */
  readonly reason?: string
}

/**
 * Undo one event with a compensating event (S16, WF-5, D6, A2, I4). The engine
 * finds the event by the `seq` that the log gave it, the one global order
 * (I4), and appends an `event.undone@1` event that records which event it
 * covers, why and who undid it: the event that it undoes stays in the log,
 * unchanged and attributed (I4, I14). The engine refuses an id that the log
 * does not hold, and an event that the flow moved past, where `finalPoint`
 * gives the reason (S16, WF-5). A side effect that already occurred is not
 * reversed (A2): the engine marks every side effect of the undone event that a
 * recorded connector call already ran as "Already sent", and the notification
 * to the people that it reached rides in the same operation (I2). The function
 * is pure and deterministic (I6).
 */
export function undo(
  eventId: number,
  reason: string,
  log: Log,
  deps: OperationDeps,
  options: UndoOptions
): UndoResult {
  const event = log.find((candidate) => candidate.seq === eventId)
  if (event === undefined) {
    return { accepted: false, reason: `the log has no event ${eventId} (I4)` }
  }
  const final = options.finalPoint?.(event, log)
  if (final !== undefined) {
    return { accepted: false, reason: `event ${eventId}: ${final}` }
  }
  const alreadySent = alreadySentEffects(event, options.calls ?? [])
  const notified = recipients(alreadySent)
  const outbox = notified.map((to) => notification(to, eventId, options.actor, reason))
  const change = { eventId, reason, notified, alreadySent }
  const operation = createOutboxOperation(EVENT_UNDONE, change, outbox, deps, options.actor)
  return { accepted: true, operation, outbox, alreadySent, notified }
}

/**
 * The compensating event that the log records for one event (S16, I4), or
 * absent when the log records no undo of it. It is the first such event: the
 * log is append-only, so an undo that the engine recorded stays where it is
 * (I4).
 */
export function undoOf(log: Log, eventId: number): Event | undefined {
  return log.find((event) => event.type === EVENT_UNDONE && event.payload.eventId === eventId)
}

/**
 * The side effects of an undone event that the log marks "Already sent" (S16,
 * A2), in the order of the undone event's side effects. The marker sits on the
 * compensating event, so a reader reads it from the log alone (I4): the status
 * and the timeline show a side effect that already occurred and stays. A log
 * that records no undo of the event marks nothing.
 */
export function alreadySentOf(log: Log, eventId: number): readonly AlreadySentEffect[] {
  const undone = undoOf(log, eventId)
  return undone === undefined ? [] : readAlreadySent(undone)
}

/**
 * The people that the undo of one event notified (S16, A2), in the order of
 * the side effects that reached them and without a repeat. They are the people
 * that the already-sent side effects of the undone event reached, and the
 * compensating event records them, so a reader reads them from the log alone
 * (I4). A log that records no undo of the event notified nobody.
 */
export function notifiedBy(log: Log, eventId: number): readonly ActorId[] {
  const undone = undoOf(log, eventId)
  return undone === undefined ? [] : readNotified(undone)
}

/**
 * The side effects of one event that already occurred (S16, A2, I13): the
 * outbox entries of the event whose connector operation a recorded call
 * already ran with the sent outcome. The engine marks them, so the log states
 * that the undo did not reverse them.
 */
function alreadySentEffects(
  event: Event,
  calls: readonly ConnectorCall[]
): readonly AlreadySentEffect[] {
  const sent = calls.filter((call) => call.outcome === SENT_OUTCOME)
  const marked: AlreadySentEffect[] = []
  for (const entry of outboxOfEvent(event)) {
    if (!sent.some((call) => call.operation === entry.operation)) continue
    const to = recipient(entry)
    marked.push({
      operation: entry.operation,
      target: entry.target,
      ...(to === undefined ? {} : { to }),
      status: ALREADY_SENT,
    })
  }
  return marked
}

/** The person that one side effect reached (S16): the `to` of its payload. */
function recipient(entry: OutboxEntry): ActorId | undefined {
  const to = entry.payload.to
  return typeof to === 'string' ? to : undefined
}

/**
 * The people that an undo notifies (S16, A2): every person that an already-sent
 * side effect reached, in order and without a repeat, so one person receives
 * one notification however many side effects reached them.
 */
function recipients(effects: readonly AlreadySentEffect[]): readonly ActorId[] {
  const people: ActorId[] = []
  for (const effect of effects) {
    if (effect.to === undefined || people.includes(effect.to)) continue
    people.push(effect.to)
  }
  return people
}

/** The notification that one affected person receives (I2, SE-2, S16). */
function notification(to: ActorId, eventId: number, actor: ActorId, reason: string): OutboxEntry {
  return {
    operation: UNDO_NOTIFICATION,
    target: EMAIL_CONNECTOR,
    payload: { to, eventId, actor, reason },
  }
}

/** Read the side effects that one compensating event marks as already sent (S16, A2). */
function readAlreadySent(event: Event): readonly AlreadySentEffect[] {
  const value = event.payload[ALREADY_SENT_KEY]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`undo: the ${ALREADY_SENT_KEY} key must be an array (S16)`)
  }
  return value as readonly AlreadySentEffect[]
}

/** Read the people that one compensating event notified (S16). */
function readNotified(event: Event): readonly ActorId[] {
  const value = event.payload[NOTIFIED_KEY]
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`undo: the ${NOTIFIED_KEY} key must be an array (S16)`)
  }
  return value as readonly ActorId[]
}
