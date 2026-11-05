import { expect, test } from 'vitest'
import { complete } from '../../engine/action.js'
import { authorize } from '../../engine/authorize.js'
import { GRANT_CHANGE_TYPE, grantsOf } from '../../engine/grants.js'
import { instanceOf } from '../../engine/instances.js'
import { timelineFor } from '../../engine/timeline.js'
import { resolveClientOperation } from '../../server/intents.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ANA,
  DANA,
  definitionV1,
  depsFor,
  directory,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  membership,
  REGISTRAR_STEP,
  REQUEST_STEP,
  SLUG,
  stateAfter,
  stepResource,
} from '../example-flow.js'
import { COMMENT, golden, grants, grantsHeld, STEP, values } from './scenario.js'

/** The registrar step of the example flow; Jordan may only send back at it (S02, AC-4). */
const REGISTRAR = stepResource(REGISTRAR_STEP)

// Issue #39: grants are derived state, a projection of the log (I4), like the
// outbox. A grant change is one attributed `config.grant.changed@1` intent
// (AC-2, I14, ADR 0010), and `grantsOf` reads the log back into the grants
// that `authorize` evaluates (AC-1). Jordan holds only
// `step.outcome:send_back` on the registrar step, so the engine lets him send
// back and refuses his approval, and the API answers 403 (AC-4). Each grant
// change shows in the change feed with its author and its time (VT-6).

test('#39 the S02 golden path runs in api, cli and dry mode: Dana grants, Jordan sends back, a grant is revoked (S02)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // (a) The projection reads the grant set back from the log (I4): the grants
  // Dana added, with Ana's reject revoked and her approve kept (AC-2).
  const held = grantsOf(state.log)
  expect(held.filter((grant) => grant.principal === JORDAN)).toEqual([
    { principal: JORDAN, scopes: ['step.outcome:send_back'], resource: REGISTRAR },
  ])
  expect(held.filter((grant) => grant.principal === ANA)).toEqual([
    { principal: ANA, scopes: ['step.outcome:approve'], resource: REGISTRAR },
  ])
  // Only scopes show (AC-2): no preset name reaches the log.
  for (const grant of held)
    expect(Object.keys(grant).sort()).toEqual(['principal', 'resource', 'scopes'])

  // (b) Jordan claimed the registrar task and sent the request back to Sam
  // with his note: the instance is a draft on the request form again (WF-3,
  // ADR 0014).
  const instance = instanceOf(state.log, INSTANCE_ID)
  expect(instance?.currentStep).toBe(REQUEST_STEP)
  expect(instance?.submitted).toBe(false)
  expect(instance?.holder).toBeUndefined()

  // (c) Each grant change shows in the change feed with an author and a time
  // (VT-6, I14): the grants and the revoke, all by Dana, in log order.
  const feed = timelineFor(state.log, { type: GRANT_CHANGE_TYPE })
  expect(feed).toHaveLength(grants.length + 1)
  expect(feed.every((entry) => entry.actor === DANA)).toBe(true)
  const granted = grants.map((_, i) => STEP.firstGrant + i + 1)
  expect(feed.map((entry) => entry.at)).toEqual([...granted, STEP.revoke + 1])
}, 60_000)

test('#39 AC-4 the step outcome scope authorizes that outcome and no other: Jordan may send back and not approve (S02)', () => {
  // The grants that apply to Jordan once Dana granted the cast (AC-1): his
  // own, and nothing of Lee's.
  const granted = golden.steps.slice(0, STEP.start)
  const jordan = grantsHeld(granted, JORDAN)
  expect(jordan).toEqual([
    { principal: JORDAN, scopes: ['step.outcome:send_back'], resource: REGISTRAR },
  ])
  expect(authorize(jordan, 'step.outcome:send_back', REGISTRAR)).toBe(true)
  expect(authorize(jordan, 'step.outcome:approve', REGISTRAR)).toBe(false)
  expect(authorize(grantsHeld(granted, LEE), 'step.outcome:approve', REGISTRAR)).toBe(true)
  // Sam starts through his group (ID-4): the group grant applies to him.
  expect(membership['user:sam']).toEqual(['All-Students'])

  // Jordan holds the registrar task (S02): the engine refuses his approval
  // and names the scope, and the API answers 403 (AC-4, I8).
  const holding = golden.steps.slice(0, STEP.jordanSendBack)
  const view = instanceAfter(holding)
  expect(view.holder).toBe(JORDAN)
  const context = {
    flow: SLUG,
    definition: definitionV1,
    grants: grantsHeld(holding, JORDAN),
    resolve: directory(values),
  }
  const approve = complete(view, JORDAN, 'approve', {}, 4, context, depsFor(STEP.jordanSendBack))
  expect(approve.accepted).toBe(false)
  expect(approve.reason).toContain('step.outcome:approve')
  const api = resolveClientOperation(
    {
      log: stateAfter(holding).log,
      principal: { id: JORDAN, groups: [] },
      grants: grantsHeld(holding, JORDAN),
      resolver: () => directory(values),
      now: () => STEP.jordanSendBack + 1,
    },
    {
      id: 'op-approve',
      type: 'step.completed@1',
      at: STEP.jordanSendBack + 1,
      actor: JORDAN,
      payload: { instanceId: INSTANCE_ID, version: 4, outcome: 'approve', values: {} },
    }
  )
  expect('error' in api && api.status).toBe(403)

  // The send back is the one outcome he may choose (AC-4, WF-3): the golden
  // step records it with his note.
  expect(golden.steps[STEP.jordanSendBack].payload.comment).toBe(COMMENT)
  expect(golden.steps[STEP.jordanSendBack].actor).toBe(JORDAN)
})
