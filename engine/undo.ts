// Issue #53, S16, WF-5, A2, D6, I2, I4, I6, I13, I14: undo a mistake with a
// compensating event. This is the commit-1 scaffold: the shape of the undo, so
// the story suite fails on the missing behavior and the parent's second commit
// fills it in.
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
import type { OutboxEntry } from './outbox.js'

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

/** Undo one event with a compensating event (S16, WF-5, D6, A2, I4). Not built yet. */
export function undo(
  _eventId: number,
  _reason: string,
  _log: Log,
  _deps: OperationDeps,
  _options: UndoOptions
): UndoResult {
  return { accepted: false, reason: 'the undo is not built yet (S16)' }
}

/** The compensating event that the log records for one event (S16, I4). Not built yet. */
export function undoOf(_log: Log, _eventId: number): Event | undefined {
  return undefined
}

/** The side effects of an undone event that the log marks "Already sent" (S16, A2). Not built yet. */
export function alreadySentOf(_log: Log, _eventId: number): readonly AlreadySentEffect[] {
  return []
}

/** The people that the undo of one event notified (S16, A2). Not built yet. */
export function notifiedBy(_log: Log, _eventId: number): readonly ActorId[] {
  return []
}
