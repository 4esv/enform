import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, test } from 'vitest'
import { claim } from '../engine/action.js'
import { apply, emptyState } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { changeTitle, type Flow } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { EMAIL_CONNECTOR, startInstance, submitInstance } from '../engine/submission.js'
import { STEP_TAKEN_OVER, takeover } from '../engine/takeover.js'
import {
  cancel,
  undoWithdrawOrCancel,
  WITHDRAW_CANCEL_NOTIFICATION,
  withdraw,
} from '../engine/withdraw.js'

// Issue #177, FM-7, DF-1, I2: the published event schemas match the payloads
// that the engine writes. The schemas are the contract (MVP.md 9.1, ADR 0004):
// a client builds the operation payload from the published schema, so the
// engine's real payload must validate against it, and a payload that breaks
// the shape must be rejected.

const repo = join(import.meta.dirname, '..')
const SLUG = 'course-overload'
const SAM = 'user:sam'

const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }]
    }
  ]
}
`)

const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

const resolve: TargetResolver = (target) => ('starter' in target ? [SAM] : [])

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

const startedValues: ConditionData = { summary: 'hello', urgent: false }
const captured: ConditionData = { summary: 'hello', detail: 'more detail' }

/** The instance id that the start mints (DX-1, #187): deterministic, like every injected source (I6). */
const INSTANCE_ID = 'inst-1'

const ajv = new Ajv2020({ logger: false })
const validateStarted = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.started@1.json'), 'utf8'))
)
const validateSubmitted = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.submitted@1.json'), 'utf8'))
)
const validateWithdrawn = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.withdrawn@1.json'), 'utf8'))
)
const validateCancelled = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.cancelled@1.json'), 'utf8'))
)
const validateUndone = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.undone@1.json'), 'utf8'))
)
const validateTitle = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'config.flow.title@1.json'), 'utf8'))
)
const validateTakenOver = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'step.taken-over@1.json'), 'utf8'))
)

test('#177 FM-7 the published event schemas match the payloads the engine writes', () => {
  const started = startInstance(flow, INSTANCE_ID, startedValues, SAM, deps(), resolve, grants)
  const submitted = submitInstance(started.instance, SAM, deps(), captured)

  // The real payloads validate against the published schemas (MVP.md 9.1).
  expect(validateStarted(started.operation.payload), 'the start payload validates').toBe(true)
  expect(validateSubmitted(submitted.operation.payload), 'the submit payload validates').toBe(true)

  // A payload that breaks the shape is rejected: the start's values must be a
  // record of field keys to JSON values, and the submit must mark submitted
  // true.
  expect(validateStarted({ ...started.operation.payload, values: 'not a record' })).toBe(false)
  expect(validateSubmitted({ ...submitted.operation.payload, submitted: false })).toBe(false)
})

// Issue #187, DX-1, ADR 0004, I4, FM-7: the published start schema carries the
// instance id, so a client builds the operation payload from the schema (MVP.md
// 9.1) and a reader of an event knows the instance the event started.

test('#187 the published start schema requires the instance id (DX-1)', () => {
  const started = startInstance(flow, INSTANCE_ID, startedValues, SAM, deps(), resolve, grants)
  const payload = started.operation.payload
  const { instanceId, ...withoutInstanceId } = payload

  expect(instanceId, 'the start payload carries the instance id').toBe(INSTANCE_ID)
  expect(validateStarted(payload), 'the real start payload validates').toBe(true)
  expect(validateStarted(withoutInstanceId), 'a payload without the instance id is rejected').toBe(
    false
  )
})

// Issue #222, I4, DF-2: the published start schema carries the flow slug, so an
// instance names the flow it runs and two flows with identical definitions do
// not collide.

test('#222 the published start schema requires the flow slug (I4)', () => {
  const started = startInstance(flow, INSTANCE_ID, startedValues, SAM, deps(), resolve, grants)
  const payload = started.operation.payload
  const { flow: startedFlow, ...withoutFlow } = payload

  expect(startedFlow, 'the start payload names the flow').toBe(SLUG)
  expect(validateStarted(payload), 'the real start payload validates').toBe(true)
  expect(validateStarted(withoutFlow), 'a payload without the flow is rejected').toBe(false)
})

// Issue #76, DX-1, #187, I4, FM-7: the published submit schema carries the
// instance id, exactly as the start schema does, so a reader of an
// instance.submitted@1 event knows which instance it acts on. The event type
// stays instance.submitted@1: no release tag exists, so the shape extends in
// place (MVP.md 9.3, #188).

test('#76 the published submit schema requires the instance id (DX-1)', () => {
  const started = startInstance(flow, INSTANCE_ID, startedValues, SAM, deps(), resolve, grants)
  const payload = submitInstance(started.instance, SAM, deps(), captured).operation.payload
  const { instanceId, ...withoutInstanceId } = payload

  expect(instanceId, 'the submit payload names the instance').toBe(INSTANCE_ID)
  expect(Object.keys(payload)[0], 'the instance id comes first').toBe('instanceId')
  expect(validateSubmitted(payload), 'the real submit payload validates').toBe(true)
  expect(
    validateSubmitted(withoutInstanceId),
    'a payload without the instance id is rejected'
  ).toBe(false)
})

// Issue #220, I14, DX-1: the published title schema matches the payload the
// engine writes. The definition format has no title, so the builder's title is
// one attributed configuration change beside the definition, and a client
// builds that operation from the published schema.

test('#220 the published title schema matches the payload the engine writes', () => {
  const operation = changeTitle(SLUG, 'Course overload', deps(), SAM)

  expect(operation.type).toBe('config.flow.title@1')
  expect(operation.actor, 'the title change is attributed').toBe(SAM)
  expect(validateTitle(operation.payload), 'the real title payload validates').toBe(true)
  expect(validateTitle({ flow: SLUG }), 'a payload without the title is rejected').toBe(false)
  expect(validateTitle({ flow: SLUG, title: 7 }), 'a non-string title is rejected').toBe(false)
})

// Issue #238, S13, WF-4, WF-5, I2, I4, I14: the published close and undo
// schemas match the payloads that the engine writes. A withdraw carries the
// notification to the closed task's holder in the same operation (I2), a
// cancel carries the required reason, and the undo names the close it
// compensates and the step and holder it restores (WF-5).

/** Priya, who holds `instance.cancel` on the flow (S13, AC-5). */
const CANCELER = 'user:priya'
const cancelGrants: readonly Grant[] = [
  ...grants,
  { principal: CANCELER, scopes: ['instance.cancel'], resource: `flow:${SLUG}` },
]

test('#242 S10 the published takeover schema matches the engine payload', () => {
  // A step whose team resolves to two assignees, so one can take the task over
  // from the other (AS-3).
  const teamDefinition: FlowDefinition = parse(`{
    "schemaVersion": 2,
    "steps": [
      { "key": "registrar", "targets": [{ "team": "registrar-office" }] }
    ]
  }`)
  const teamFlow: Flow = {
    slug: 'registrar-flow',
    versions: [
      { version: 1, contentHash: contentHash(teamDefinition), definition: teamDefinition },
    ],
  }
  const ANA = 'user:ana'
  const teamResolve: TargetResolver = (target) => ('team' in target ? [SAM, ANA] : [])
  const teamGrants: readonly Grant[] = [
    { principal: SAM, scopes: ['instance.start'], resource: `flow:${teamFlow.slug}` },
  ]

  // One source, so every operation gets a distinct ID (I1).
  const sources = deps()
  const started = startInstance(
    teamFlow,
    'inst-takeover',
    {},
    SAM,
    sources,
    teamResolve,
    teamGrants
  )
  const applied = apply(started.operation, emptyState)
  const claimed = claim(
    { ...started.instance, version: applied.log.length },
    SAM,
    applied.log.length,
    sources
  )
  if (!claimed.accepted || claimed.operation === undefined) throw new Error(claimed.reason)
  const held = apply(claimed.operation, applied)

  const taken = takeover(
    claimed.instance,
    ANA,
    'Lee is out until 10/19',
    1_700_000_100_000,
    0,
    claimed.instance.version ?? 0,
    held.log,
    sources
  )
  expect(taken.accepted).toBe(true)
  if (taken.operation === undefined) throw new Error(taken.reason)
  expect(taken.operation.type).toBe(STEP_TAKEN_OVER)
  expect(validateTakenOver(taken.operation.payload), 'the takeover payload validates').toBe(true)
  expect(
    validateTakenOver({ ...taken.operation.payload, from: undefined }),
    'a takeover without the previous holder is rejected'
  ).toBe(false)
  expect(
    validateTakenOver({ ...taken.operation.payload, why: '' }),
    'a takeover without a reason is rejected'
  ).toBe(false)
  expect(
    validateTakenOver({ ...taken.operation.payload, outbox: 'none' }),
    'a malformed outbox is rejected'
  ).toBe(false)
})

test('#238 S13 the published close and undo schemas match the engine payloads', () => {
  const started = startInstance(flow, INSTANCE_ID, startedValues, SAM, deps(), resolve, grants)
  const claimed = claim(started.instance, SAM, started.instance.version ?? 0, deps())
  if (!claimed.accepted) throw new Error(claimed.reason)
  const held = claimed.instance

  const withdrawn = withdraw(held, SAM, 'Dropped a class', deps())
  expect(withdrawn.accepted).toBe(true)
  if (withdrawn.operation === undefined) throw new Error(withdrawn.reason)
  expect(withdrawn.operation.payload.outbox, 'the holder is notified in the same event').toEqual([
    {
      operation: WITHDRAW_CANCEL_NOTIFICATION,
      target: EMAIL_CONNECTOR,
      payload: { to: SAM, step: 'request', actor: SAM, reason: 'Dropped a class' },
    },
  ])
  expect(validateWithdrawn(withdrawn.operation.payload), 'the withdraw payload validates').toBe(
    true
  )
  expect(
    validateWithdrawn({ ...withdrawn.operation.payload, reason: 7 }),
    'a non-string reason is rejected'
  ).toBe(false)
  expect(
    validateWithdrawn({ ...withdrawn.operation.payload, outbox: 'none' }),
    'a malformed outbox is rejected'
  ).toBe(false)

  const cancelled = cancel(
    held,
    CANCELER,
    'Duplicate of #4411',
    { flow: SLUG, grants: cancelGrants },
    deps()
  )
  expect(cancelled.accepted).toBe(true)
  if (cancelled.operation === undefined) throw new Error(cancelled.reason)
  expect(validateCancelled(cancelled.operation.payload), 'the cancel payload validates').toBe(true)
  expect(
    validateCancelled({ ...cancelled.operation.payload, reason: '' }),
    'a cancel without a reason is rejected'
  ).toBe(false)

  const undone = undoWithdrawOrCancel(
    withdrawn.instance,
    SAM,
    withdrawn.instance.version ?? 0,
    24 * 3_600_000,
    1_700_000_100_000,
    deps()
  )
  expect(undone.accepted).toBe(true)
  if (undone.operation === undefined) throw new Error(undone.reason)
  expect(validateUndone(undone.operation.payload), 'the undo payload validates').toBe(true)
  expect(
    validateUndone({ ...undone.operation.payload, undoOf: 'deleted' }),
    'an undo of anything but a close is rejected'
  ).toBe(false)
  expect(
    validateUndone({ ...undone.operation.payload, step: 3 }),
    'an undo without a step is rejected'
  ).toBe(false)
})
