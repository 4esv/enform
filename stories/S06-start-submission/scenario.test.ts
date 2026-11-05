import { expect, test } from 'vitest'
import { apply, emptyState } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { addGrant, grantsOf } from '../../engine/grants.js'
import type { OperationDeps } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import {
  ASSIGNMENT_EMAIL,
  EMAIL_CONNECTOR,
  INSTANCE_STARTED,
  INSTANCE_SUBMITTED,
  startInstance,
  submitInstance,
} from '../../engine/submission.js'
import { flow, INSTANCE_ID, resolve, SLUG, samData, samGrants, versionV1 } from './scenario.js'

/** Sam, the signed-in principal who starts the submission (S06, ID-2). */
const SAM = 'user:sam'

/** Dr. Okafor, the advisor who receives the assignment email (S06, SE-1). */
const OKAFOR = 'user:okafor'

/** The injected sources of the path (I6): the clock is a fixed time and the IDs are `op-N`. */
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

/** The grants that the log records, read back into the grants that authorize evaluates (AC-1, I4). */
function grantsFromLog(grants: readonly Grant[]): readonly Grant[] {
  let state = emptyState
  grants.forEach((grant, index) => {
    state = apply(
      addGrant(grant, 'dana', { clock: () => index + 1, ids: () => `grant-${index + 1}` }),
      state
    )
  })
  return grantsOf(state.log)
}

// Issue #43: Sam starts and submits a submission (S06). An authenticated start
// creates a private draft on the request form (ID-2, ADR 0014). The submit
// routes it to the first later step whose skip condition is false (WF-1, I10)
// and, in the same operation, records the assignment email to its assignee
// (I2, SE-1). A start with no principal,
// or without instance.start on the flow, is refused (ID-2, AC-1). The path is
// deterministic (I6).

test('#43 a start is a private draft and the submit routes it with the assignment email (S06)', () => {
  // (a) Sam holds instance.start on the flow, read back from the log (AC-1, I4).
  const grants = grantsFromLog(samGrants)
  const started = startInstance(flow, INSTANCE_ID, samData, SAM, deps(), resolve, grants)
  expect(started.operation.type).toBe(INSTANCE_STARTED)
  expect(started.operation.actor).toBe(SAM)

  // The draft is stamped with version 1 and sits on the request form, the
  // first step, with Sam as its only assignee (DF-2, ADR 0014, I13). It routes
  // nothing yet: the submit decides the route from the values Sam submits.
  expect(started.instance.definitionVersion).toBe(versionV1.contentHash)
  expect(started.instance.currentStep).toBe('request')
  expect(started.instance.submitted).toBe(false)
  expect(started.instance.values).toEqual(samData)
  expect(started.instance.assignees).toEqual([
    { step: 'request', target: { starter: 'starter' }, members: [SAM] },
  ])

  // (b) The submit completes the request form, skips the triage step (the
  // request is not urgent, WF-1, S05), routes to the advisor, whose target
  // names Dr. Okafor (I10, I13), and records the assignment email in one
  // operation (S06, I2, SE-1).
  const result = submitInstance(
    started.instance,
    SAM,
    samData,
    0,
    { flow: SLUG, definition: versionV1.definition, resolve, grants },
    deps()
  )
  expect(result.accepted).toBe(true)
  if (result.operation === undefined) throw new Error(result.reason)
  expect(result.instance.submitted).toBe(true)
  expect(result.instance.values).toEqual(samData)
  expect(result.instance.currentStep).toBe('advisor')
  expect(result.instance.assignees).toContainEqual({
    step: 'advisor',
    target: { user: OKAFOR },
    members: [OKAFOR],
  })
  expect(result.operation.type).toBe(INSTANCE_SUBMITTED)
  expect(result.operation.actor).toBe(SAM)

  // One apply commits the route and its side effect together (I2): the outbox
  // is the projection of that one event, so the email arrived with the route.
  const state = apply(result.operation, emptyState)
  expect(state.log).toHaveLength(1)
  expect(outboxOf(state.log)).toEqual([
    {
      operation: ASSIGNMENT_EMAIL,
      target: EMAIL_CONNECTOR,
      payload: { to: OKAFOR, step: 'advisor' },
    },
  ])
  expect(state.log[0].payload).toMatchObject({
    step: 'request',
    currentStep: 'advisor',
    submitted: true,
    skipped: [{ step: 'triage', condition: { '==': [{ var: 'urgent' }, false] } }],
  })

  // (c) The engine never creates an anonymous draft (ID-2): a start with no
  // principal is refused.
  expect(() =>
    startInstance(flow, INSTANCE_ID, samData, undefined, deps(), resolve, grants)
  ).toThrow(/signed-in principal/)

  // A start without instance.start on the flow is refused (AC-1, I8).
  const noStart: readonly Grant[] = [
    { principal: SAM, scopes: ['flow.read'], resource: `flow:${SLUG}` },
  ]
  expect(() => startInstance(flow, INSTANCE_ID, samData, SAM, deps(), resolve, noStart)).toThrow(
    /instance\.start/
  )

  // (d) I6: the same inputs give the same draft.
  const twice = startInstance(flow, INSTANCE_ID, samData, SAM, deps(), resolve, grants)
  expect(twice.instance).toEqual(started.instance)
})
