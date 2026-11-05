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

import { authorize, type Grant } from './authorize.js'
import type { Version } from './concurrency.js'
import type { FlowDefinition } from './definition.js'
import type { ConnectorCall, Instance } from './instance.js'
import type { ActorId, Event, Log, Operation, OperationDeps } from './operation.js'
import { createOutboxOperation, type OutboxEntry, outboxOfEvent } from './outbox.js'

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
  // The compensating event names the instance the undone event acted on, so
  // the instance projection folds the undo with the instance's own events
  // (#256, I4, DX-1).
  const instanceId = event.payload.instanceId
  const change = {
    ...(typeof instanceId === 'string' ? { instanceId } : {}),
    eventId,
    reason,
    notified,
    alreadySent,
  }
  const operation = createOutboxOperation(EVENT_UNDONE, change, outbox, deps, options.actor)
  return { accepted: true, operation, outbox, alreadySent, notified }
}

/** The versioned event type of a release (WF-5, #256): the holder returns the task to the pool. */
export const TASK_RELEASED = 'task.released@1'

/** The versioned event type of a reassign (WF-5, #256): a flow owner gives the task to a principal. */
export const TASK_REASSIGNED = 'task.reassigned@1'

/**
 * The manual actions on an instance that a compensating event can undo (WF-5,
 * MVP.md 5.4): a claim, a release, a takeover, a reassign, an outcome and a
 * send back. A withdraw and a cancel have their own undo (`instance.undone@1`,
 * S13), and a start, a draft edit and a submit are the starter's own form.
 */
export const UNDOABLE_TYPES: readonly string[] = [
  // The literals, not the modules' constants: the instance projection imports
  // this module and the action modules import the projection, so the
  // constants of action.ts, sendBack.ts and takeover.ts are not initialized
  // when this list is built (an ESM cycle). The event types are a public
  // surface (MVP.md 9.1), so the literals cannot drift.
  'step.claimed@1',
  TASK_RELEASED,
  'step.taken-over@1',
  TASK_REASSIGNED,
  'step.completed@1',
  'step.sent-back@1',
]

/** The event type of a completion, as a literal for the same reason as UNDOABLE_TYPES. */
const COMPLETED = 'step.completed@1'

/** The event type of a takeover, as a literal for the same reason as UNDOABLE_TYPES. */
const TAKEN_OVER = 'step.taken-over@1'

/** The previous holder that a takeover names, for the refusal's reason (S10, WF-5). */
function takenFromHint(event: Event): string {
  const from = event.payload.from
  return event.type === TAKEN_OVER && typeof from === 'string' ? `, ${from}` : ''
}

/** The email connector, as a literal: submission.ts imports the projection, which imports this module. */
const EMAIL = 'connector-smtp'

/**
 * The seqs of the events that a compensating event on the log undid (I4,
 * D6). A projection folds the instance without them; the timeline keeps both.
 */
export function undoneSeqs(log: Log): ReadonlySet<number> {
  const seqs = new Set<number>()
  for (const event of log) {
    if (event.type !== EVENT_UNDONE) continue
    const target = event.payload.eventId
    if (typeof target === 'number') seqs.add(target)
  }
  return seqs
}

/**
 * The events of a log that still stand (I4, D6): every event that no
 * compensating event undid. The compensating events themselves stay, so a
 * fold that counts actions counts the undo as one.
 */
export function standingEvents(log: Log): readonly Event[] {
  const undone = undoneSeqs(log)
  return log.filter((event) => !undone.has(event.seq))
}

/** What an undo of an action needs beside the instance and the event (#256, S16, WF-5). */
export type UndoActionContext = {
  readonly flow: string
  readonly definition: FlowDefinition
  readonly log: Log
  /** The grants that apply to the acting principal (I8); a flow owner holds `task.reassign`. */
  readonly grants: readonly Grant[]
  /** The server clock (I6): the undo period is measured on it. */
  readonly now: number
  /** The undo period of the flow in milliseconds (WF-5). */
  readonly undoPeriod: number
}

/** The result of an undo of an action: the undo result and the HTTP status of a refusal. */
export type UndoActionResult = UndoResult & { readonly status?: 403 | 409 }

/**
 * Undo the latest action on an instance (#256, S16, S10, WF-5, D6, A2, I4,
 * I5, I8, I14). The engine refuses a stale view (I5), an event that is not
 * the instance's own or not a manual action (MVP.md 5.4), an event already
 * undone, an action under a later standing action (the undo reverses the
 * newest change only, so no state is invented), an actor who neither made the
 * action, nor was the holder a takeover took it from (S10), nor owns the flow
 * (`task.reassign`, I8), an undo after the flow's
 * period (WF-5), and any undo once the instance completed the flow's final
 * step (S16). It then appends the compensating event through `undo`, with the
 * instance's connector calls deciding which side effects already occurred
 * (A2). It is pure and deterministic (I6).
 */
export function undoAction(
  instance: Instance,
  actor: ActorId,
  eventId: number,
  reason: string,
  expectedVersion: Version,
  context: UndoActionContext,
  deps: OperationDeps
): UndoActionResult {
  const own = context.log.filter((event) => event.payload.instanceId === instance.instanceId)
  const event = own.find((candidate) => candidate.seq === eventId)
  if (event === undefined) {
    return { accepted: false, status: 409, reason: `the instance has no event ${eventId} (I4)` }
  }
  if (expectedVersion !== (instance.version ?? 0)) {
    return { accepted: false, status: 409, reason: 'the view is stale, refresh and retry' }
  }
  if (!UNDOABLE_TYPES.includes(event.type)) {
    return {
      accepted: false,
      status: 409,
      reason: `event ${eventId}: ${event.type} is not undoable`,
    }
  }
  if (reason.trim() === '') {
    return { accepted: false, status: 409, reason: 'an undo needs a reason (WF-5)' }
  }
  const undone = undoneSeqs(own)
  if (undone.has(eventId)) {
    return { accepted: false, status: 409, reason: `event ${eventId} is already undone` }
  }
  const standing = own.filter(
    (candidate) => UNDOABLE_TYPES.includes(candidate.type) && !undone.has(candidate.seq)
  )
  const latest = standing[standing.length - 1]
  if (latest === undefined || latest.seq !== eventId) {
    return {
      accepted: false,
      status: 409,
      reason: `event ${eventId} is not the latest action on the instance; undo event ${latest?.seq ?? 'none'} first`,
    }
  }
  const owner = authorize(context.grants, 'task.reassign', `flow:${context.flow}`)
  // A takeover is undone by the person it was taken from as well (S10, WF-5):
  // Lee comes back and keeps his task without an administrator.
  const takenFrom = event.type === TAKEN_OVER && event.payload.from === actor
  if (event.actor !== actor && !owner && !takenFrom) {
    return {
      accepted: false,
      status: 403,
      reason: `${actor} may not undo event ${eventId}: only ${event.actor ?? 'its actor'}${takenFromHint(event)} or a flow owner may (WF-5)`,
    }
  }
  if (context.now - event.at > context.undoPeriod) {
    return {
      accepted: false,
      status: 409,
      reason: `event ${eventId}: the undo period of the flow has passed (WF-5)`,
    }
  }
  const final = context.definition.finalStep
  const passedFinal =
    final !== undefined &&
    standing.some((candidate) => candidate.type === COMPLETED && candidate.payload.step === final)
  if (passedFinal) {
    return {
      accepted: false,
      status: 409,
      reason: `the instance completed the final step ${final}, so nothing on it can be undone (WF-5)`,
    }
  }
  const result = undo(eventId, reason, context.log, deps, {
    actor,
    calls: instance.connectorCalls,
  })
  return result.accepted ? result : { ...result, status: 409 }
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
    target: EMAIL,
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
