// Issue #191, FM-3, FM-4, FM-7, AC-4, AS-2, ADR 0010, DX-1, DF-2, I1, I6, I8,
// A9, S09: resolve a completion intent through the engine.
//
// FM-4 says the server runs the editability rule again at each submission and
// does not trust client state, and A9 forbids the interface from deciding
// correctness. A client that posted a resolved `step.completed@1` operation
// chose the step, the transition, the outcome's authorization and the captured
// values itself; this module is the resolved path ADR 0010 gives it instead.
// The client names the instance, the outcome it chose and the values it
// captured, and the engine projects the instance from the log (I4), reads the
// published definition it is pinned to (DF-2), and runs the same `complete()`
// that the engine path uses, so the transition, the authorization (AC-4, I8)
// and the editability refusal (FM-3, FM-4) stay engine decisions. The client's
// ID and time survive because they are the injected sources (I1, I6). The
// function is pure and deterministic (I6): it reads no clock, no random source
// and no I/O of its own.

import { complete, STEP_COMPLETED } from './action.js'
import type { Grant } from './authorize.js'
import type { JsonValue } from './definition.js'
import type { FieldError } from './fields.js'
import { publishedByHash } from './flow.js'
import { instanceOf } from './instances.js'
import type { ActorId, Log, Operation, OperationId } from './operation.js'
import type { TargetResolver } from './routing.js'

/**
 * The client intent for a completion (ADR 0010, #191): the pieces a browser
 * honestly knows. It carries the ID the client chose (I1), the time it read
 * (I6), the principal it acts as (ID-2), the instance it acts on (DX-1), the
 * version of the instance it read (I5, #222), the outcome the actor chose
 * (AC-4) and the values the step captured (FM-7). It names no step: the engine
 * reads the instance's current step from the log. Everything else is the
 * engine's to resolve.
 */
export type CompletionIntent = {
  readonly id: OperationId
  readonly type: typeof STEP_COMPLETED
  readonly at: number
  readonly actor: ActorId
  readonly payload: {
    readonly instanceId: string
    /** The instance version that the client read (I5, #222). */
    readonly version: number
    readonly outcome: string
    readonly values: Readonly<Record<string, JsonValue>>
  }
}

/**
 * The engine refused the completion (FM-3, FM-4, AS-2, AC-4): the actor does
 * not hold the step, the outcome is not authorized, a captured key is not
 * editable on the current step, or a captured value fails its control or a
 * required field. It is not a malformed request, so the server serves it as
 * 409 with the reason, which names the field for FM-3, and with every
 * validation error by field path for FM-4.
 */
export class CompletionRefused extends Error {
  /** Every validation error of the refusal, by field path (FM-4); empty when `message` names the one reason (FM-3, AC-4). */
  readonly errors: readonly FieldError[]

  constructor(reason: string, errors: readonly FieldError[] = []) {
    super(reason)
    this.errors = errors
  }
}

/**
 * Resolve a completion intent into the operation the engine records (ADR 0010,
 * #191, FM-3, FM-4, AC-4, I8). A completion intent names the instance, the
 * outcome the actor chose and the values the step captured; the engine
 * projects the instance from the log (I4), reads the published definition that
 * the instance is pinned to (DF-2), and calls `complete()`, so the current
 * step, the transition, the outcome's authorization, the editability of every
 * captured key and the validation of every captured value (FM-4) are all
 * engine decisions. The client's ID and time
 * survive because they are the injected sources (I1, I6): the function reads
 * no clock and no random source of its own.
 *
 * It answers `undefined` when `value` is not a completion intent, so an
 * already resolved operation keeps the low-level append path. A value shaped
 * as a completion intent that cannot be resolved throws a named `intent: ...`
 * error, and an engine refusal throws `CompletionRefused`; neither appends
 * anything (the A9 defect ADR 0010 removed).
 */
export function resolveCompletion(
  log: Log,
  value: unknown,
  resolve?: TargetResolver,
  grants?: readonly Grant[]
): Operation | undefined {
  const intent = asCompletionIntent(value)
  if (intent === undefined) return undefined
  const instance = instanceOf(log, intent.payload.instanceId)
  if (instance === undefined) {
    throw new Error(`intent: the log holds no instance ${intent.payload.instanceId} (DX-1)`)
  }
  const published = publishedByHash(log, instance.definitionVersion)
  if (published === undefined) {
    throw new Error(
      `intent: the instance ${intent.payload.instanceId} has no published definition to complete on (DF-2)`
    )
  }
  const result = complete(
    instance,
    intent.actor,
    intent.payload.outcome,
    intent.payload.values,
    // The version the client read (I5, #222): a stale view is refused at once
    // rather than overwriting a newer decision.
    intent.payload.version,
    { flow: instance.flow, definition: published.definition, grants, resolve },
    { clock: () => intent.at, ids: () => intent.id }
  )
  if (!result.accepted || result.operation === undefined) {
    throw new CompletionRefused(result.reason ?? 'the completion was refused', result.errors ?? [])
  }
  return result.operation
}

/**
 * Read a completion intent from an unknown value, or undefined when it is not
 * one (ADR 0010). A resolved `step.completed@1` operation carries the `step`
 * it acted on, so the detector answers undefined for it and the low-level
 * append path stays unchanged. An intent-shaped value that lacks the instance
 * id, the id, the time, the actor or the values throws a named error instead
 * of being appended raw (the A9 defect ADR 0010 removed).
 */
function asCompletionIntent(value: unknown): CompletionIntent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.type !== STEP_COMPLETED) return undefined
  const payload = candidate.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const change = payload as Record<string, unknown>
  // A resolved completion names the step it acted on; an intent never does.
  if ('step' in change) return undefined
  if (typeof change.outcome !== 'string') return undefined
  if (typeof change.instanceId !== 'string') {
    throw new Error('intent: the instanceId must be a string (DX-1)')
  }
  if (typeof change.version !== 'number' || !Number.isInteger(change.version)) {
    throw new Error('intent: the version must be an integer (I5)')
  }
  if (typeof candidate.id !== 'string') throw new Error('intent: the id must be a string (I1)')
  if (typeof candidate.at !== 'number') throw new Error('intent: the at must be a number (I6)')
  if (typeof candidate.actor !== 'string') {
    throw new Error('intent: the actor must name a principal (ID-2)')
  }
  const values = change.values
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('intent: the values must be an object (FM-7)')
  }
  return {
    id: candidate.id,
    type: STEP_COMPLETED,
    at: candidate.at,
    actor: candidate.actor,
    payload: {
      instanceId: change.instanceId,
      version: change.version,
      outcome: change.outcome,
      values: values as Readonly<Record<string, JsonValue>>,
    },
  }
}
