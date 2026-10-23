// Issue #52, S15, VT-5, VT-6, DF-6, I4, I6, I13, I14: the timeline and the
// change feed.
//
// S15: Dana investigates a problem. The timeline is a projection of the
// append-only log (I4), never a second store: the log is the one global order,
// and instance events and configuration changes share it (VT-5, S15). The
// change feed filters that projection by flow slug and by event type (VT-6),
// so a reader finds the cause. Every entry carries the actor of the change
// (I14), and a connector call shows its operation, its time and its outcome
// and never a response body (I13). The functions are pure and deterministic
// (I6): they read no clock, no random source and no I/O.

import type { ActorId, Event, Log } from './operation.js'
import { STEP_SENT_BACK } from './sendBack.js'

/** The event type of a recorded connector call (I13, S15). */
export const CONNECTOR_CALLED = 'connector.called@1'

/** The prefix of every configuration change (I14). */
const CONFIG_PREFIX = 'config.'

/**
 * Whether an event type is a configuration change (I14, VT-6). A configuration
 * change names its kind in the type, for example `config.definition.published@1`,
 * and the instance timeline keeps them apart from the instance's own events.
 */
export function isConfigChange(type: string): boolean {
  return type.startsWith(CONFIG_PREFIX)
}

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
  /** The step key that the payload carries, when it carries one (VT-5, VT-6). */
  readonly step?: string
  /** The comment that the payload carries, for a note or a send back (VT-5, VT-6). */
  readonly comment?: string
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

/**
 * The timeline (VT-5, S15): the entries of the log, in order. The timeline is
 * a projection of the log, never a second store (I4), so a rebuild reproduces
 * it and no two entries have an ambiguous order: `seq` is the one global order
 * of I4. Instance events and configuration changes share the feed. Pure and
 * deterministic (I6).
 */
export function timeline(log: Log): readonly TimelineEntry[] {
  return log.map(entryOf)
}

/**
 * The change feed, filtered (VT-6, S15). It keeps the entries that name the
 * flow and the entries of the event type, in log order; an absent filter keeps
 * every entry. It is a projection of the log (I4), so it reads no second
 * store, and it is pure and deterministic (I6).
 */
export function timelineFor(log: Log, filter: TimelineFilter): readonly TimelineEntry[] {
  return timeline(log).filter((entry) => matches(entry, filter))
}

/** Project one event of the log into one entry of the timeline (VT-5, VT-6, I13). */
function entryOf(event: Event): TimelineEntry {
  const flow = flowOf(event)
  const step = stepOf(event)
  const comment = commentOf(event)
  const call = event.type === CONNECTOR_CALLED ? callOf(event) : undefined
  return {
    seq: event.seq,
    at: event.at,
    ...(event.actor === undefined ? {} : { actor: event.actor }),
    type: event.type,
    ...(flow === undefined ? {} : { flow }),
    ...(step === undefined ? {} : { step }),
    ...(comment === undefined ? {} : { comment }),
    ...(call === undefined ? {} : { call }),
  }
}

/** Whether one entry passes the filter of the change feed (VT-6). */
function matches(entry: TimelineEntry, filter: TimelineFilter): boolean {
  if (filter.flow !== undefined && entry.flow !== filter.flow) return false
  if (filter.type !== undefined && entry.type !== filter.type) return false
  return true
}

/**
 * The slug of the flow that an event names (VT-6, I4). A publication carries
 * its slug directly, a definition or title change carries its `flow`, a start
 * names the flow it runs, and a grant carries its resource, of the form
 * `flow:<slug>` or `flow:<slug>/step:<key>`. An event that names no flow has
 * none, so a flow filter does not keep it. The server uses it to filter the
 * log for one instance's configuration changes; it reads no other store and
 * no clock (I6).
 */
export function flowOf(event: Event): string | undefined {
  const payload = event.payload
  if (typeof payload.slug === 'string') return payload.slug
  if (typeof payload.flow === 'string') return payload.flow
  if (typeof payload.resource === 'string') return slugOfResource(payload.resource)
  return undefined
}

/**
 * The step key that one event's payload carries (VT-5, VT-6). A claim, a
 * completion, a skip and a close name `step`; a send back names the step it
 * addresses as `to`, which is the step the note and the reopened activity sit
 * on (WF-3). An event that names no step has none.
 */
function stepOf(event: Event): string | undefined {
  const step = event.payload.step
  if (typeof step === 'string') return step
  if (event.type !== STEP_SENT_BACK) return undefined
  const to = event.payload.to
  return typeof to === 'string' ? to : undefined
}

/** The comment that one event's payload carries, when it carries one (VT-5, WF-3). */
function commentOf(event: Event): string | undefined {
  const comment = event.payload.comment
  return typeof comment === 'string' ? comment : undefined
}

/** The slug in a resource of the form `flow:<slug>...` (MVP.md 5.6, VT-6). */
function slugOfResource(resource: string): string | undefined {
  const match = /^flow:([^/]+)/.exec(resource)
  return match === null ? undefined : match[1]
}

/**
 * The connector call that one event records (I13). It reads the operation, the
 * time and the outcome, and only those three: the projection never carries a
 * response body, even when a malformed payload smuggles one.
 */
function callOf(event: Event): TimelineCall {
  const operation = event.payload.operation
  const time = event.payload.time
  const outcome = event.payload.outcome
  if (typeof operation !== 'string') {
    throw new Error(`timeline: ${CONNECTOR_CALLED} has no operation (I13)`)
  }
  if (typeof time !== 'number') {
    throw new Error(`timeline: ${CONNECTOR_CALLED} has no time (I13)`)
  }
  if (typeof outcome !== 'string') {
    throw new Error(`timeline: ${CONNECTOR_CALLED} has no outcome (I13)`)
  }
  return { operation, time, outcome }
}
