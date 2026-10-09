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
import { flow, resolve, SLUG, samData, samGrants, versionV1 } from './scenario.js'

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
// creates a draft routed to the first step's assignees (ID-2, WF-1, I10). The
// submit marks the instance submitted and, in the same operation, records the
// assignment email to the first assignee (I2, SE-1). A start with no principal,
// or without instance.start on the flow, is refused (ID-2, AC-1). The path is
// deterministic (I6). The first check is marked expected to fail until the
// submission workflow is implemented.

test.fails('#43 a start routes a draft and the submit records the assignment email (S06)', () => {
  // (a) Sam holds instance.start on the flow, read back from the log (AC-1, I4).
  const grants = grantsFromLog(samGrants)
  const started = startInstance(flow, samData, SAM, deps(), resolve, grants)
  expect(started.operation.type).toBe(INSTANCE_STARTED)
  expect(started.operation.actor).toBe(SAM)

  // The draft is stamped with version 1 and the assignees of the first step
  // whose skip condition is false (DF-2, WF-1, I13): the triage step is
  // skipped, so the current step is advisor and its target names Dr. Okafor
  // (I10).
  expect(started.instance.definitionVersion).toBe(versionV1.contentHash)
  expect(started.instance.currentStep).toBe('advisor')
  expect(started.instance.submitted).toBe(false)
  expect(started.instance.assignees).toEqual([
    { step: 'advisor', target: { user: OKAFOR }, members: [OKAFOR] },
  ])

  // (b) The submit marks the instance submitted and records the assignment
  // email to the first assignee in one operation (S06, I2, SE-1).
  const submitted = submitInstance(started.instance, SAM, deps())
  expect(submitted.instance.submitted).toBe(true)
  expect(submitted.operation.type).toBe(INSTANCE_SUBMITTED)
  expect(submitted.operation.actor).toBe(SAM)

  // One apply commits the mark and its side effect together (I2): the outbox
  // is the projection of that one event, so the email arrived with the mark.
  const state = apply(submitted.operation, emptyState)
  expect(state.log).toHaveLength(1)
  expect(outboxOf(state.log)).toEqual([
    {
      operation: ASSIGNMENT_EMAIL,
      target: EMAIL_CONNECTOR,
      payload: { to: OKAFOR, step: 'advisor' },
    },
  ])
  expect(state.log[0].payload).toMatchObject({ currentStep: 'advisor', submitted: true })

  // (c) The engine never creates an anonymous draft (ID-2): a start with no
  // principal is refused.
  expect(() => startInstance(flow, samData, undefined, deps(), resolve, grants)).toThrow(
    /signed-in principal/
  )

  // A start without instance.start on the flow is refused (AC-1, I8).
  const noStart: readonly Grant[] = [
    { principal: SAM, scopes: ['flow.read'], resource: `flow:${SLUG}` },
  ]
  expect(() => startInstance(flow, samData, SAM, deps(), resolve, noStart)).toThrow(
    /instance\.start/
  )

  // (d) I6: the same inputs give the same draft and the same route.
  const twice = startInstance(flow, samData, SAM, deps(), resolve, grants)
  expect(twice.instance).toEqual(started.instance)
})
