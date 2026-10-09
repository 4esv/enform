// Issue #7, I1, I4, I6, I14, ADR 0004: the operation, event and log model.

/** A client-created operation ID. ADR 0004 makes it a UUIDv7. */
export type OperationId = string

/** The clock, injected so that no code reads the system clock (I6). */
export type Clock = () => number

/** The operation ID generator, injected for the same reason (I6). */
export type IdGenerator = () => OperationId

/** The injected sources that create an operation: the clock and the ID generator (I6). */
export type OperationDeps = {
  readonly clock: Clock
  readonly ids: IdGenerator
}

/**
 * A principal ID: a user, a group or a team (MVP.md 3). It is immutable, so a
 * name or an email address never identifies a principal (ID-4).
 */
export type ActorId = string

/**
 * One change (MVP.md 3). Every change is an operation, and the client creates
 * its ID. The engine applies it idempotently (I1).
 */
export type Operation = {
  readonly id: OperationId
  /** The versioned event type that this operation records (MVP.md 9.1). */
  readonly type: string
  /** The time of the change, from the injected clock (I6). */
  readonly at: number
  /**
   * Who made the change (I14). An operation that affects no behavior may omit
   * it; a change that affects behavior always names its principal.
   */
  readonly actor?: ActorId
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * An immutable, ordered record of an occurrence (MVP.md 3). The single writer
 * assigns `seq`, the one global order (ADR 0004).
 */
export type Event = {
  readonly seq: number
  readonly operationId: OperationId
  readonly type: string
  readonly at: number
  /** Who made the change (I14). It is the actor of the operation that records it. */
  readonly actor?: ActorId
  readonly payload: Readonly<Record<string, unknown>>
}

/** The single sequence of all events, in one global order (MVP.md 3). */
export type Log = readonly Event[]

/**
 * The type of a redaction event (Issue #10, I4, D5). I4 forbids updating or
 * deleting an event; a redaction is the only exception, and it is itself an
 * appended event. It requires `org.redact` (MVP.md 5.6), it is attributed, and
 * it is not reversible. This is the shape only: the redaction logic arrives
 * with the story that needs it.
 */
export const REDACT_TYPE = 'log.redacted@1'

/** The payload of a redaction event: which event it covers and why (D5). */
export type RedactionPayload = {
  /** The `seq` of the event that the redaction covers. */
  readonly targetSeq: number
  /** Why the redaction happened, for the audit trail. */
  readonly reason: string
}

/**
 * Create a client operation from an injected clock and ID generator (I6). Two
 * operations with the same ID are the same change, however often they arrive.
 * A change that affects behavior also passes the actor who made it (I14).
 */
export function createOperation(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  deps: OperationDeps,
  actor?: ActorId
): Operation {
  return { id: deps.ids(), type, at: deps.clock(), actor, payload }
}
