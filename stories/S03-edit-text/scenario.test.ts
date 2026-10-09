import { expect, test } from 'vitest'
import { apply, emptyState } from '../../engine/apply.js'
import { authorize, type Grant } from '../../engine/authorize.js'
import { classifyChange } from '../../engine/edit.js'
import { createFlow, push } from '../../engine/flow.js'
import { addGrant, grantsOf } from '../../engine/grants.js'
import { runGolden } from '../../tools/harness/runner.js'
import { goldenView, stepOperation } from '../../tools/harness/scenario.js'
import { danaGrant, draft, edited, FLOW, golden, priyaGrant, SLUG, withStep } from './scenario.js'

// The injected sources of the golden path (I6): the clock is the step index
// and the IDs are `op-N`, exactly as `stepOperation` builds them, so the push
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

// Issue #40: Priya holds `flow.edit` and not `flow.build`, so the class of a
// definition change decides whether her push succeeds (DF-5, D2). A change to
// an option is edit-class, so her push succeeds and the log attributes it to
// her (DF-5, I14). A change that adds a step is structural, so the engine
// rejects it without `flow.build`, and the message names the change and the
// scope (DF-5, I1, AC-1). The literal label and field cases arrive with FM-1
// (issue #74).

test('#40 the engine guards an edit-class push and rejects a structural one (S03)', async () => {
  // (a) The classification: an option change is edit-class; a step change is
  // structural (DF-5, D2).
  expect(classifyChange(draft, edited)).toEqual([
    { class: 'edit', message: 'an option was added to step advisor: escalate' },
  ])
  expect(classifyChange(draft, withStep)).toEqual([
    { class: 'structural', message: 'a step was added: chair' },
  ])

  // (b) The grants come from the log (I4): grantsOf reads Priya's grant back,
  // and AC-1 authorizes against it.
  const grantLog = apply(addGrant(priyaGrant, 'dana', stepDeps(0)), emptyState).log
  const priya = heldBy('user:priya', grantsOf(grantLog))
  expect(priya).toEqual([priyaGrant])
  expect(authorize(priya, 'flow.edit', FLOW)).toBe(true)
  expect(authorize(priya, 'flow.build', FLOW)).toBe(false)

  // (c) Dana builds the first draft (structural, `flow.build`), then Priya
  // pushes her edit (edit-class, `flow.edit`). The pushes are the golden path,
  // operation for operation (I6).
  let flow = createFlow(SLUG)
  const first = push(flow, draft, stepDeps(0), 'dana', [danaGrant])
  flow = first.flow
  const change = push(flow, edited, stepDeps(1), 'user:priya', priya)
  expect([first.operation, change.operation]).toEqual(
    golden.steps.map((step, index) => stepOperation(step, index))
  )

  // (d) Priya's edit-class push succeeds and the log attributes it to her
  // (DF-5, I14).
  expect(change.flow.draft).toEqual(edited)
  expect(change.operation.actor).toBe('user:priya')

  // (e) The same grants cannot make a structural change (DF-5, D2). The
  // rejection names the change and the scope that it needs.
  expect(() => push(flow, withStep, stepDeps(2), 'user:priya', priya)).toThrow(/a step was added/)
  expect(() => push(flow, withStep, stepDeps(2), 'user:priya', priya)).toThrow(/flow\.build/)

  // (f) Dana holds `flow.build`, so her structural push succeeds (D2).
  const built = push(flow, withStep, stepDeps(2), 'dana', [danaGrant])
  expect(built.flow.draft).toEqual(withStep)

  // (g) The api-mode run reaches the golden end state (I6), and the change
  // feed records the author of each change (DF-5, I14).
  await runGolden(golden)
  const log = goldenView(golden).log
  expect(log).toHaveLength(2)
  expect(log.map((event) => event.actor)).toEqual(['dana', 'user:priya'])
})
