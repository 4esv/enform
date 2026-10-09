// Issue #7, I1, I4, I6, ADR 0004: the operation, event and log model.

/** A client-created operation ID. ADR 0004 makes it a UUIDv7. */
export type OperationId = string

/** The clock, injected so that no code reads the system clock (I6). */
export type Clock = () => number

/** The operation ID generator, injected for the same reason (I6). */
export type IdGenerator = () => OperationId

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
 */
export function createOperation(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  deps: { readonly clock: Clock; readonly ids: IdGenerator }
): Operation {
  return { id: deps.ids(), type, at: deps.clock(), payload }
}
