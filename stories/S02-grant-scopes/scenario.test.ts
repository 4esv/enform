import { expect, test } from 'vitest'
import { authorize, type Grant } from '../../engine/authorize.js'
import { addGrant, GRANT_CHANGE_TYPE, grantsOf } from '../../engine/grants.js'
import { runGolden } from '../../tools/harness/runner.js'
import { goldenView, stepOperation } from '../../tools/harness/scenario.js'
import { golden, grants } from './scenario.js'

/** The registrar step of the example flow; Jordan may only send back at it (S02, AC-4). */
const REGISTRAR = 'flow:course-overload/step:registrar'

// The injected sources of the golden path (I6): the clock is the step index
// and the IDs are `op-N`, exactly as `stepOperation` builds them, so the grant
// operations equal the scenario's.
function stepDeps(index: number): { clock: () => number; ids: () => string } {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

// The grants that one principal holds. AC-1 authorizes against those grants:
// the caller passes the principal's own grants and those of its groups and
// teams, and the function reads nothing else (I8).
function heldBy(principal: string, held: readonly Grant[]): Grant[] {
  return held.filter((grant) => grant.principal === principal)
}

// Issue #39: grants are derived state, a projection of the log (I4), like the
// outbox. A grant change is one attributed `config.grant.changed@1` operation
// (AC-2, I14), and `grantsOf` reads the log back into the grants that
// `authorize` evaluates (AC-1). Jordan holds only `step.outcome:send_back` on
// the registrar step, so the engine authorizes Send back and refuses approve
// (AC-4).

test('#39 grants derive from the log and scope each principal to its outcomes (S02)', async () => {
  // The grant operations are the golden path, operation for operation (I14).
  expect(grants.map((grant, index) => addGrant(grant, 'dana', stepDeps(index)))).toEqual(
    golden.steps.map((step, index) => stepOperation(step, index))
  )

  // The api-mode run reaches the golden end state (I6).
  await runGolden(golden)

  // (a) The projection reads the grant set back from the log (I4).
  const log = goldenView(golden).log
  const held = grantsOf(log)
  expect(heldBy('user:jordan', held)).toEqual([
    { principal: 'user:jordan', scopes: ['step.outcome:send_back'], resource: REGISTRAR },
  ])

  // (b) AC-4: the `step.outcome:<name>` scope authorizes that outcome and no
  // other. Only Jordan's own grants apply to Jordan (AC-1).
  const jordan = heldBy('user:jordan', held)
  expect(authorize(jordan, 'step.outcome:send_back', REGISTRAR)).toBe(true)
  expect(authorize(jordan, 'step.outcome:approve', REGISTRAR)).toBe(false)
  // The two principals are distinct: lee holds approve on the same step.
  expect(authorize(heldBy('user:lee', held), 'step.outcome:approve', REGISTRAR)).toBe(true)

  // (c) I14: Dana authored every grant change.
  const events = log.filter((event) => event.type === GRANT_CHANGE_TYPE)
  expect(events).toHaveLength(grants.length)
  expect(events.every((event) => event.actor === 'dana')).toBe(true)
})
