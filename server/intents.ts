// Issue #256, ADR 0010, A9, I1, I5, I8, I14: the client intents, resolved
// through the engine. A client writes an intent: the operation ID it chose,
// the event type, the actor and the values it honestly knows. This module
// turns the intent into the operation the engine decides, or into the refusal
// with its HTTP status, and it is pure: it reads no clock, no database and no
// directory of its own. The release server (server/http.ts) gives it the log,
// the session principal, the grants, the directory resolver and the server
// clock, and appends what it answers; the story harness
// (tools/harness/server.ts) gives it the same seams in memory, so api mode
// proves the release write path.
//
// Issue #222, #224, #236, #238, #242, #252: the resolvers below moved here from
// the release server unchanged in what they decide. Each one loads the
// instance from the log, passes the session principal as the actor, lets the
// engine decide the transition, the authorization and the side effects, and
// maps the engine's refusal to 400, 403 or 409.

import { claim, STEP_CLAIMED, STEP_COMPLETED } from '../engine/action.js'
import { authorize, type Grant } from '../engine/authorize.js'
import { CompletionRefused, resolveCompletion } from '../engine/completions.js'
import { takeoverIdleMs } from '../engine/definition.js'
import { publishedByHash } from '../engine/flow.js'
import { addGrant, flowOwner, GRANT_CHANGE_TYPE, grantsOf } from '../engine/grants.js'
import { instanceOf } from '../engine/instances.js'
import type { ActorId, Log, Operation } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { STEP_SENT_BACK, sendBack } from '../engine/sendBack.js'
import {
  DRAFT_EDITED,
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  resolveDraftEditIntent,
  resolveIntent,
  resolveSubmitIntent,
  SubmitRefused,
} from '../engine/submission.js'
import { STEP_TAKEN_OVER, takeover } from '../engine/takeover.js'
import { teamsOf } from '../engine/teams.js'
import { EVENT_UNDONE, undoAction } from '../engine/undo.js'
import {
  cancel,
  INSTANCE_CANCELLED,
  INSTANCE_UNDONE,
  INSTANCE_WITHDRAWN,
  undoWithdrawOrCancel,
  withdraw,
} from '../engine/withdraw.js'

/**
 * The undo period of a flow that does not set one (WF-5, S13, S16): 24 hours,
 * the server default that `undoHours` overrides.
 */
const DEFAULT_UNDO_HOURS = 24

/** One hour in milliseconds, the unit that the engine's undo period takes. */
const HOUR_MS = 3_600_000

/** The signed-in principal that an intent acts as (ID-4, ADR 0012): its id and the groups it holds. */
export type ActingPrincipal = {
  readonly id: ActorId
  readonly groups: readonly string[]
}

/**
 * The seams of one resolution (I6, ADR 0010): the log, the acting principal,
 * the grants that apply to it, the directory resolver of one instance, and the
 * server clock that stamps a close, measures an idle period and bounds an undo.
 */
export type IntentContext = {
  readonly log: Log
  readonly principal: ActingPrincipal
  /** The grants that apply to the principal, as `grantsFor` reads them (AC-1, I8). */
  readonly grants: readonly Grant[]
  /** The directory resolver for an instance with this starter and these values (AS-1, AS-4). */
  readonly resolver: (
    starter: ActorId | undefined,
    data: Readonly<Record<string, unknown>>
  ) => TargetResolver
  /** The server clock (I6). A client time is only the envelope's time. */
  readonly now: () => number
  /** The undo period for a flow that sets none, in hours (WF-5); absent means 24. */
  readonly defaultUndoHours?: number
}

/** The operation the engine decided, or the refusal with the HTTP status the server answers. */
export type IntentResult =
  | { readonly operation: Operation }
  | {
      readonly status: 400 | 403 | 409
      readonly error: string
      readonly errors?: readonly unknown[]
    }

/** The event types that `resolveClientOperation` serves as intents (ADR 0010). */
export const INTENT_TYPES: readonly string[] = [
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  DRAFT_EDITED,
  STEP_COMPLETED,
  STEP_CLAIMED,
  GRANT_CHANGE_TYPE,
  STEP_SENT_BACK,
  INSTANCE_WITHDRAWN,
  INSTANCE_CANCELLED,
  INSTANCE_UNDONE,
  STEP_TAKEN_OVER,
  EVENT_UNDONE,
]

/**
 * Whether a posted body is a client intent that the resolver serves, rather
 * than an already resolved operation (ADR 0010). A start intent names a flow
 * and no definition version; a completion intent names no step; a claim names
 * the version it read; a grant is always an intent; the other served types
 * are intents when they carry none of the fields that only the engine writes.
 * The story harness uses this to keep the raw append path for the operations
 * a scenario declares resolved.
 */
export function isClientIntent(body: Record<string, unknown>): boolean {
  const type = body.type
  if (typeof type !== 'string' || !INTENT_TYPES.includes(type)) return false
  const payload = isRecord(body.payload) ? body.payload : {}
  if (type === INSTANCE_STARTED) return !('definitionVersion' in payload)
  if (type === INSTANCE_SUBMITTED) return !('step' in payload) && !('submitted' in payload)
  if (type === DRAFT_EDITED) return true
  if (type === STEP_COMPLETED) return !('step' in payload)
  if (type === STEP_CLAIMED) return 'expectedVersion' in payload
  if (type === GRANT_CHANGE_TYPE) return true
  if (type === STEP_SENT_BACK) return !('from' in payload) && !('revision' in payload)
  if (type === INSTANCE_WITHDRAWN || type === INSTANCE_CANCELLED) {
    return !hasEngineCloseField(payload)
  }
  if (type === INSTANCE_UNDONE) return !hasEngineUndoField(payload)
  if (type === EVENT_UNDONE) return !('notified' in payload) && !('alreadySent' in payload)
  return !hasEngineTakeoverField(payload)
}

/**
 * Resolve one client intent through the engine and answer the operation the
 * engine decided, or the refusal (ADR 0010, #222, #256, A9). The session
 * principal is the actor, so a client-supplied actor is ignored for
 * authorization (I8). A raw start or completion is refused: the client posts
 * the intent. A type that no resolver serves answers 400.
 */
export function resolveClientOperation(
  context: IntentContext,
  body: Record<string, unknown>
): IntentResult {
  const { log, principal, grants } = context
  const actor = principal.id
  try {
    if (body.type === INSTANCE_STARTED) {
      const payload = isRecord(body.payload) ? body.payload : {}
      const values = isRecord(payload.values) ? payload.values : {}
      const resolver = context.resolver(actor, values)
      const flowSlug = stringValue(payload.flow) ?? ''
      const operation = resolveIntent(
        log,
        { ...body, actor },
        resolver,
        grants,
        flowOwner(log, flowSlug) ?? actor
      )
      if (operation === undefined) {
        return {
          status: 400,
          error: 'a raw instance.started@1 is refused; post the start intent (ADR 0010)',
        }
      }
      return { operation }
    }
    if (body.type === INSTANCE_SUBMITTED) {
      // The submit routes the draft (ADR 0014): the resolver reads the draft's
      // starter and values for the dynamic targets, and the flow owner gets
      // the alert of an unroutable step (I10).
      const payload = isRecord(body.payload) ? body.payload : {}
      const instanceId = stringValue(payload.instanceId)
      const instance = instanceId === undefined ? undefined : instanceOf(log, instanceId)
      const values = { ...instance?.values, ...(isRecord(payload.values) ? payload.values : {}) }
      const resolver = context.resolver(instance?.starter, values)
      const owner = instance === undefined ? actor : (flowOwner(log, instance.flow) ?? actor)
      const operation = resolveSubmitIntent(log, { ...body, actor }, resolver, grants, owner)
      if (operation === undefined) {
        return {
          status: 400,
          error: 'a raw instance.submitted@1 is refused; post the submit intent (ADR 0010)',
        }
      }
      return { operation }
    }
    if (body.type === DRAFT_EDITED) {
      const operation = resolveDraftEditIntent(log, { ...body, actor })
      if (operation === undefined) return { status: 400, error: 'a draft edit needs values' }
      return { operation }
    }
    if (body.type === STEP_COMPLETED) {
      const payload = isRecord(body.payload) ? body.payload : {}
      const instanceId = stringValue(payload.instanceId)
      const instance = instanceId === undefined ? undefined : instanceOf(log, instanceId)
      const resolver = context.resolver(instance?.starter, instance?.values ?? {})
      const owner = instance === undefined ? actor : (flowOwner(log, instance.flow) ?? actor)
      const operation = resolveCompletion(log, { ...body, actor }, resolver, grants, owner)
      if (operation === undefined) {
        return {
          status: 400,
          error: 'a raw step.completed@1 is refused; post the completion intent (ADR 0010)',
        }
      }
      return { operation }
    }
    if (body.type === STEP_CLAIMED) {
      return claimOperation(log, principal, body)
    }
    if (body.type === GRANT_CHANGE_TYPE) {
      return grantOperation(body, principal, grants)
    }
    if (body.type === STEP_SENT_BACK) {
      return sendBackOperation(context, body)
    }
    if (body.type === INSTANCE_WITHDRAWN) {
      return withdrawOperation(context, body)
    }
    if (body.type === INSTANCE_CANCELLED) {
      return cancelOperation(context, body)
    }
    if (body.type === INSTANCE_UNDONE) {
      return undoOperation(context, body)
    }
    if (body.type === STEP_TAKEN_OVER) {
      return takeoverOperation(context, body)
    }
    if (body.type === EVENT_UNDONE) {
      return undoActionOperation(context, body)
    }
    return { status: 400, error: `the operation type ${String(body.type)} is not served` }
  } catch (error) {
    if (error instanceof CompletionRefused) {
      return { status: 409, error: error.message, errors: error.errors }
    }
    if (error instanceof SubmitRefused) {
      return { status: error.status, error: error.message, errors: error.errors }
    }
    return { status: 400, error: messageOf(error) }
  }
}

/**
 * Apply a claim through the engine (S09, AS-2, I5, #222). The request carries
 * the instance version it read as `expectedVersion`; the engine checks it and
 * records the claim, so the field never reaches the log. The session principal
 * is the actor, and a refusal answers 409 with the reason.
 */
function claimOperation(
  log: Log,
  principal: ActingPrincipal,
  body: Record<string, unknown>
): IntentResult {
  const payload = isRecord(body.payload) ? body.payload : undefined
  const instanceId = stringValue(payload?.instanceId)
  const expectedVersion = payload?.expectedVersion
  if (
    instanceId === undefined ||
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return { status: 400, error: 'a claim needs an id, a time, an instance and expectedVersion' }
  }
  const instance = instanceOf(log, instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${instanceId} (DX-1)` }
  }
  const result = claim(instance, principal.id, expectedVersion, {
    clock: () => body.at as number,
    ids: () => body.id as string,
  })
  if (!result.accepted || result.operation === undefined) {
    return { status: 409, error: result.reason ?? 'the claim was refused' }
  }
  return { operation: result.operation }
}

/**
 * Apply a send back through the engine (S11, WF-3, AC-4, I5, #236). The
 * client posts the intent: the instance, the earlier step it names, the
 * required comment and the version it read. The server loads the instance,
 * passes the session principal as the actor, and lets the engine decide the
 * holder, the target step, the comment, the version and the authorization.
 * A refusal answers 409 with the engine's reason, except a blank comment,
 * which is a 400 because the engine refused the request itself (WF-3). A raw
 * resolved `step.sent-back@1` carries `from` or `revision` and is refused.
 */
function sendBackOperation(context: IntentContext, body: Record<string, unknown>): IntentResult {
  const { log, principal, grants } = context
  const payload = isRecord(body.payload) ? body.payload : undefined
  if (
    payload !== undefined &&
    (payload.from !== undefined || payload.revision !== undefined || payload.outbox !== undefined)
  ) {
    return { status: 400, error: 'a raw step.sent-back@1 is refused; post the send-back intent' }
  }
  const instanceId = stringValue(payload?.instanceId)
  const to = stringValue(payload?.to)
  const comment = typeof payload?.comment === 'string' ? payload.comment : undefined
  const version = payload?.version
  if (
    instanceId === undefined ||
    to === undefined ||
    to === '' ||
    comment === undefined ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return {
      status: 400,
      error: 'a send back needs an id, a time, an instance, a target step, a comment and a version',
    }
  }
  const instance = instanceOf(log, instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${instanceId} (DX-1)` }
  }
  const published = publishedByHash(log, instance.definitionVersion)
  if (published === undefined) {
    return { status: 400, error: `the log holds no published definition for ${instanceId}` }
  }
  const result = sendBack(
    instance,
    principal.id,
    to,
    comment,
    version,
    {
      flow: instance.flow,
      definition: published.definition,
      grants,
      resolve: context.resolver(instance.starter, instance.values ?? {}),
    },
    { clock: () => body.at as number, ids: () => body.id as string }
  )
  if (!result.accepted || result.operation === undefined) {
    return {
      status: result.refusal === 'comment' ? 400 : 409,
      error: result.reason ?? 'the send back was refused',
    }
  }
  return { operation: result.operation }
}

/** One close intent (S13, WF-4): the instance, the reason and the version the client read. */
type CloseIntent = {
  readonly instanceId: string
  readonly reason: string
  readonly version: number
  readonly id: string
}

/**
 * Read a withdraw or cancel intent (S13, WF-4). The client posts the intent,
 * not the resolved event: a raw close carries the engine's `step`, `holder`,
 * `previousStep` or `outbox` field and is refused (A9, ADR 0010).
 */
function readCloseIntent(body: Record<string, unknown>): CloseIntent | undefined {
  const payload = isRecord(body.payload) ? body.payload : undefined
  if (payload !== undefined && hasEngineCloseField(payload)) return undefined
  const instanceId = stringValue(payload?.instanceId)
  const reason = typeof payload?.reason === 'string' ? payload.reason : undefined
  const version = payload?.version
  if (
    instanceId === undefined ||
    reason === undefined ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return undefined
  }
  return { instanceId, reason, version, id: body.id }
}

/**
 * Apply a withdrawal through the engine (S13, WF-4, AC-5, I5, #238). The
 * client posts the intent; the server loads the instance, passes the session
 * principal as the actor, and lets the engine decide the state, the previous
 * step and holder and the notification. The engine decides the close; the
 * server decides whether the view the client acted on is still current. A
 * withdrawn instance closes a task that is open now, so a stale `version` is
 * refused here before the engine runs (I5). Only the starter may withdraw
 * (AC-5), so any other actor answers 403 with the engine's reason.
 */
function withdrawOperation(context: IntentContext, body: Record<string, unknown>): IntentResult {
  const { log, principal } = context
  const intent = readCloseIntent(body)
  if (intent === undefined) {
    return {
      status: 400,
      error: 'a withdraw needs an id, a time, an instance, a reason and a version',
    }
  }
  const instance = instanceOf(log, intent.instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${intent.instanceId} (DX-1)` }
  }
  if (intent.version !== (instance.version ?? 0)) {
    return { status: 409, error: 'the view is stale, refresh and retry' }
  }
  // The server clock stamps the close, not the client's `at`: the undo period
  // is measured from this time, so a client clock cannot extend or shorten it.
  const at = context.now()
  const result = withdraw(instance, principal.id, intent.reason, {
    clock: () => at,
    ids: () => intent.id,
  })
  if (!result.accepted || result.operation === undefined) {
    return {
      status: closeStatus(result.reason),
      error: result.reason ?? 'the withdraw was refused',
    }
  }
  return { operation: result.operation }
}

/**
 * Apply a cancellation through the engine (S13, WF-4, AC-5, AC-1, I5, #238).
 * The engine authorizes `instance.cancel` on the flow, refuses an empty reason
 * (MVP.md 5.6), closes the open task and returns the notification in the same
 * operation (I2). The server refuses a stale view before the engine runs, and
 * maps the engine's refusals to 400, 403 and 409.
 */
function cancelOperation(context: IntentContext, body: Record<string, unknown>): IntentResult {
  const { log, principal, grants } = context
  const intent = readCloseIntent(body)
  if (intent === undefined) {
    return {
      status: 400,
      error: 'a cancel needs an id, a time, an instance, a reason and a version',
    }
  }
  const instance = instanceOf(log, intent.instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${intent.instanceId} (DX-1)` }
  }
  if (intent.version !== (instance.version ?? 0)) {
    return { status: 409, error: 'the view is stale, refresh and retry' }
  }
  // The server clock stamps the close (S13, WF-5): the undo period is measured
  // from the server's time, never from a client time that could be backdated.
  const at = context.now()
  const result = cancel(
    instance,
    principal.id,
    intent.reason,
    { flow: instance.flow, grants },
    { clock: () => at, ids: () => intent.id }
  )
  if (!result.accepted || result.operation === undefined) {
    const reason = result.reason ?? 'the cancel was refused'
    return { status: cancelStatus(reason), error: reason }
  }
  return { operation: result.operation }
}

/**
 * Apply the undo of a withdrawal or a cancellation through the engine (S13,
 * WF-5, I4, #238). The client posts the instance and the version it read. The
 * flow's `undoHours` sets the period; an absent setting uses the server
 * default. The engine accepts only the closer and only within the period, and
 * appends a compensating event that restores the previous step and holder; a
 * wrong actor, a stale view or a late undo answers 409 (WF-5).
 */
function undoOperation(context: IntentContext, body: Record<string, unknown>): IntentResult {
  const { log, principal } = context
  const payload = isRecord(body.payload) ? body.payload : undefined
  const instanceId = stringValue(payload?.instanceId)
  const version = payload?.version
  if (
    payload === undefined ||
    hasEngineUndoField(payload) ||
    instanceId === undefined ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return { status: 400, error: 'an undo needs an id, a time, an instance and a version' }
  }
  const instance = instanceOf(log, instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${instanceId} (DX-1)` }
  }
  const published = publishedByHash(log, instance.definitionVersion)
  if (published === undefined) {
    return { status: 400, error: `the log holds no published definition for ${instanceId}` }
  }
  const undoPeriod =
    (published.definition.undoHours ?? context.defaultUndoHours ?? DEFAULT_UNDO_HOURS) * HOUR_MS
  // The period is checked against the server clock, and the undo carries that
  // clock too, so a client cannot backdate `at` to undo after the flow's
  // period (S13, WF-5, I6). The client's `at` is only the envelope's time and
  // is not trusted for this decision.
  const at = context.now()
  const result = undoWithdrawOrCancel(instance, principal.id, version, undoPeriod, at, {
    clock: () => at,
    ids: () => body.id as string,
  })
  if (!result.accepted || result.operation === undefined) {
    return { status: 409, error: result.reason ?? 'the undo was refused' }
  }
  return { operation: result.operation }
}

/**
 * Apply a takeover through the engine (S10, AS-3, WF-5, I5, I14, #242). The
 * client posts the intent: the instance, the reason and the version it read.
 * The server loads the instance and the log, reads the step's takeover setting
 * from the pinned definition, and passes the session principal as the actor,
 * the computed idle period and the server clock as `now`. The engine decides
 * the assignee, the reassign, the attribution and the notification; the
 * client's id and time are only the operation's id and time. A step that never
 * allows a takeover, a raw resolved takeover, a missing reason and a stale
 * view are refused; every engine refusal except authorization answers 409 with
 * the reason, the remaining idle time included.
 */
function takeoverOperation(context: IntentContext, body: Record<string, unknown>): IntentResult {
  const { log, principal } = context
  const payload = isRecord(body.payload) ? body.payload : undefined
  if (payload !== undefined && hasEngineTakeoverField(payload)) {
    return { status: 400, error: 'a raw step.taken-over@1 is refused; post the takeover intent' }
  }
  const instanceId = stringValue(payload?.instanceId)
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : undefined
  const version = payload?.version
  if (
    instanceId === undefined ||
    reason === undefined ||
    reason === '' ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return {
      status: 400,
      error: 'a takeover needs an id, a time, an instance, a reason and a version',
    }
  }
  const instance = instanceOf(log, instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${instanceId} (DX-1)` }
  }
  const published = publishedByHash(log, instance.definitionVersion)
  if (published === undefined) {
    return { status: 400, error: `the log holds no published definition for ${instanceId}` }
  }
  const step = published.definition.steps.find((entry) => entry.key === instance.currentStep)
  if (step === undefined) {
    return { status: 409, error: 'the instance has no current step to take over' }
  }
  const idleTimeout = takeoverIdleMs(step)
  if (idleTimeout === undefined) {
    return { status: 409, error: `step ${step.key}: the step does not allow a takeover` }
  }
  // The idle period is measured on the server clock (AS-3): the client's `at`
  // only stamps the operation, so a client time cannot shorten the wait.
  const now = context.now()
  const result = takeover(instance, principal.id, reason, now, idleTimeout, version, log, {
    clock: () => body.at as number,
    ids: () => body.id as string,
  })
  if (!result.accepted || result.operation === undefined) {
    return {
      status: takeoverStatus(result.reason),
      error: result.reason ?? 'the takeover was refused',
    }
  }
  return { operation: result.operation }
}

/**
 * Apply the undo of an action through the engine (S16, S10, WF-5, D6, I4,
 * I5, I8, #256). The client posts the instance, the seq of the event it
 * undoes, the reason and the version it read; the engine decides whether the
 * event is the latest action, whether the actor made it or owns the flow,
 * whether the flow's undo period and final step allow it, and which side
 * effects already occurred. The period is measured on the server clock, so a
 * client time cannot extend it.
 */
function undoActionOperation(context: IntentContext, body: Record<string, unknown>): IntentResult {
  const { log, principal, grants } = context
  const payload = isRecord(body.payload) ? body.payload : undefined
  const instanceId = stringValue(payload?.instanceId)
  const eventId = payload?.eventId
  const reason = typeof payload?.reason === 'string' ? payload.reason : undefined
  const version = payload?.version
  if (
    instanceId === undefined ||
    typeof eventId !== 'number' ||
    !Number.isInteger(eventId) ||
    reason === undefined ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return {
      status: 400,
      error: 'an undo needs an id, a time, an instance, an eventId, a reason and a version',
    }
  }
  const instance = instanceOf(log, instanceId)
  if (instance === undefined) {
    return { status: 400, error: `the log holds no instance ${instanceId} (DX-1)` }
  }
  const published = publishedByHash(log, instance.definitionVersion)
  if (published === undefined) {
    return { status: 400, error: `the log holds no published definition for ${instanceId}` }
  }
  const undoPeriod =
    (published.definition.undoHours ?? context.defaultUndoHours ?? DEFAULT_UNDO_HOURS) * HOUR_MS
  const result = undoAction(
    instance,
    principal.id,
    eventId,
    reason,
    version,
    {
      flow: instance.flow,
      definition: published.definition,
      log,
      grants,
      now: context.now(),
      undoPeriod,
    },
    { clock: () => body.at as number, ids: () => body.id as string }
  )
  if (!result.accepted || result.operation === undefined) {
    return { status: result.status ?? 409, error: result.reason ?? 'the undo was refused' }
  }
  return { operation: result.operation }
}

/** The engine fields that only a resolved takeover carries (S10, ADR 0010). */
function hasEngineTakeoverField(payload: Record<string, unknown>): boolean {
  return ['step', 'from', 'to', 'when', 'why', 'outbox'].some((key) => payload[key] !== undefined)
}

/** The HTTP status of a takeover refusal: authorization is 403, every other refusal is 409. */
function takeoverStatus(reason: string | undefined): 403 | 409 {
  return reason?.includes('is not an assignee') ? 403 : 409
}

/** The engine fields that only a resolved close carries (S13, WF-4, ADR 0010). */
function hasEngineCloseField(payload: Record<string, unknown>): boolean {
  return ['step', 'holder', 'previousStep', 'outbox'].some((key) => payload[key] !== undefined)
}

/** The engine fields that only a resolved undo carries (WF-5, ADR 0010). */
function hasEngineUndoField(payload: Record<string, unknown>): boolean {
  return ['undoOf', 'step', 'holder', 'previousStep'].some((key) => payload[key] !== undefined)
}

/** The HTTP status of a close refusal: authorization is 403, everything else 409. */
function closeStatus(reason: string | undefined): 403 | 409 {
  if (reason === undefined) return 409
  if (reason.includes('is not the starter') || reason.includes('lacks instance.cancel')) {
    return 403
  }
  return 409
}

/** The HTTP status of a cancel refusal: a missing reason is the request, not the state (MVP.md 5.6). */
function cancelStatus(reason: string): 400 | 403 | 409 {
  if (reason.includes('needs a reason')) return 400
  return closeStatus(reason)
}

/**
 * Resolve one grant change (#224, AC-2, AC-4, I14). The client names the
 * principal, the scopes and the resource; the server authorizes `org.grants`
 * on `org` or `flow.grant` on the resource, then records the grant with the
 * client's ID and time, so a retry with the same ID appends nothing (I1). A
 * member of a team or a group reaches this through the grants that apply to
 * it, because the caller already merged them. Any other configuration event is
 * refused, so the write path serves only this one kind.
 */
function grantOperation(
  body: Record<string, unknown>,
  principal: ActingPrincipal,
  grants: readonly Grant[]
): IntentResult {
  const payload = isRecord(body.payload) ? body.payload : undefined
  const grantPrincipal = stringValue(payload?.principal)
  const resource = stringValue(payload?.resource)
  const scopes = payload?.scopes
  if (
    grantPrincipal === undefined ||
    resource === undefined ||
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((scope) => typeof scope === 'string' && scope !== '') ||
    typeof body.id !== 'string' ||
    typeof body.at !== 'number'
  ) {
    return {
      status: 400,
      error: 'a grant needs an id, a time, a principal, scopes and a resource',
    }
  }
  const allowed =
    authorize(grants, 'org.grants', 'org') || authorize(grants, 'flow.grant', resource)
  if (!allowed) {
    return {
      status: 403,
      error: `a grant requires the scope org.grants on org or flow.grant on ${resource}`,
    }
  }
  const operation = addGrant({ principal: grantPrincipal, scopes, resource }, principal.id, {
    clock: () => body.at as number,
    ids: () => body.id as string,
  })
  return { operation }
}

/**
 * The grants that apply to one principal (AC-1, I8, #222): its own grants, the
 * grants of the groups the session lists, and the grants of the teams that hold
 * it. The log is the source of truth, so a rebuild reproduces the set.
 */
export function grantsFor(log: Log, principal: ActingPrincipal): readonly Grant[] {
  const held = new Set<string>([principal.id])
  for (const group of principal.groups) {
    held.add(group)
    held.add(`group:${group}`)
  }
  for (const team of teamsOf(log)) {
    if (!teamHolds(team.members, principal)) continue
    held.add(team.name)
    held.add(`team:${team.name}`)
  }
  return grantsOf(log).filter((grant) => held.has(grant.principal))
}

/** Whether a team's members name the principal, directly or through one of its groups (AS-6). */
function teamHolds(members: readonly string[], principal: ActingPrincipal): boolean {
  for (const member of members) {
    if (member === principal.id) return true
    const group = member.startsWith('group:') ? member.slice('group:'.length) : member
    if (principal.groups.includes(group)) return true
  }
  return false
}

/**
 * The team membership that a target resolves through (AS-4, #222): the
 * `team_members` projection, with the engine's own team projection as the
 * fallback that a store without the rows still answers. A team that neither
 * holds resolves to nobody, so the engine routes to the Unroutable queue (I10).

/**
 * Build the target resolver of one request (AS-1, AS-4, I10, #222, #252).
 * `starter` resolves to the principal that started the instance, `user` to
 * itself, `field` to the principal in the data or the instance values, `team`
 * to the team membership, and `group` to the members that the Keycloak group
 * holds now. A missing or unknown group resolves to nobody, and the engine
 * routes the task to the Unroutable queue (I10); `manager-of` has no directory
 * source either.
 */
export function resolverFor(
  starter: string | undefined,
  data: Readonly<Record<string, unknown>>,
  teamMembers: ReadonlyMap<string, readonly string[]>,
  groupMembers: ReadonlyMap<string, readonly string[]>
): TargetResolver {
  return (target) => {
    if ('user' in target) return [target.user]
    if ('starter' in target) return starter === undefined ? [] : [starter]
    if ('field' in target) {
      const value = data[target.field]
      return typeof value === 'string' && value !== '' ? [value] : []
    }
    if ('team' in target) return teamMembers.get(target.team) ?? []
    if ('group' in target) return groupMembers.get(target.group) ?? []
    return []
  }
}

/**
 * The group directory of one request (AS-1, I10, #252): the Keycloak groups
 * that the Admin API lists, mapped from the group id that a target names to
 * the ids of the members it holds now. The map is built once per request, like
 * `teamMembersFor`, so a re-resolution in the same request reads one snapshot.

/** A string payload value, or undefined when it is another type. */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Whether a value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
