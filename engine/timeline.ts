// Issue #52, S15, VT-5, VT-6, I4, I6, I13, I14: the timeline and the change
// feed. This is the commit-1 scaffold: the shape of the projection, so the
// story suite fails on the missing behavior and the parent's second commit
// fills it in.

import type { ActorId, Log } from './operation.js'

/** The event type of a recorded connector call (I13, S15). */
export const CONNECTOR_CALLED = 'connector.called@1'

/**
 * One connector call as the timeline shows it (I13): the operation that ran,
 * the time and the outcome. It never carries a response body.
 */
export type TimelineCall = {
  /** The connector operation that ran (I13). */
  readonly operation: string
  /** The time of the call, from the injected clock (I6). */
  readonly time: number
  /** What the call resulted in, an outcome and never a response body (I13). */
  readonly outcome: string
}

/**
 * One entry of the timeline (VT-5, S15). It is one event of the log, in the
 * one global order (I4): instance events and configuration changes share it,
 * so no two entries have an ambiguous order, and `seq` is the position.
 */
export type TimelineEntry = {
  /** The position of the event in the log, the one global order (I4). */
  readonly seq: number
  /** The time of the event, from the injected clock (I6). */
  readonly at: number
  /** Who made the change (I14); absent for an occurrence that is not a change. */
  readonly actor?: ActorId
  /** The versioned event type (MVP.md 9.1). */
  readonly type: string
  /** The slug of the flow that the entry belongs to, when the event names one (VT-6). */
  readonly flow?: string
  /** The connector call, when the event records one (I13). */
  readonly call?: TimelineCall
}

/** The filter of the change feed (VT-6): by flow slug and by event type. */
export type TimelineFilter = {
  /** The slug of the flow to keep (VT-6); absent keeps every flow. */
  readonly flow?: string
  /** The event type to keep (VT-6); absent keeps every type. */
  readonly type?: string
}

/** The timeline (VT-5, S15): the entries of the log, in order. Not built yet. */
export function timeline(_log: Log): readonly TimelineEntry[] {
  return []
}

/** The change feed, filtered (VT-6, S15). Not built yet. */
export function timelineFor(_log: Log, _filter: TimelineFilter): readonly TimelineEntry[] {
  return []
}
