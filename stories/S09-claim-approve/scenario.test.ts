import { expect, test } from 'vitest'
import {
  type ActionResult,
  type CompletionContext,
  claim,
  complete,
  STEP_CLAIMED,
  STEP_COMPLETED,
} from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Instance } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import { startInstance } from '../../engine/submission.js'
import {
  ANA,
  ARCHIVE_STEP,
  data,
  definition,
  flow,
  LEE,
  leeGrants,
  REGISTRAR_MEMBERS,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  resolve,
  SLUG,
  STARTER,
  starterGrants,
  terminalDefinition,
} from './scenario.js'

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

/** Apply the operation that an accepted action returned (I14); the test checks acceptance first. */
function applyAction(result: ActionResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the action was refused: ${result.reason}`)
  return apply(result.operation, state)
}

// Issue #46: two assignees claim the registrar task at the same time; exactly
// one succeeds (AS-2, I5). The holder completes it with approve, which his
// `step.outcome:approve` grant authorizes and no other outcome does (AC-4). A
// holder with a stale view has the completion refused by the version check, so
// there is no second approval (I5). The path is deterministic (I6).

test('#46 exactly one claim succeeds and the holder completes with an authorized outcome (S09)', () => {
  // One shared source, so every recorded operation gets a distinct ID (I1): a
  // repeated ID would be the same change and `apply` would ignore it.
  const sources = deps()

  // The start routes the request to the registrar step, whose team target
  // resolves to Lee, Ana and Jordan (S06, I10, I13).
  const started = startInstance(flow, data, STARTER, sources, resolve, starterGrants)
  const state = apply(started.operation, emptyState)
  expect(started.instance.currentStep).toBe(REGISTRAR_STEP)
  expect(started.instance.assignees).toEqual([
    { step: REGISTRAR_STEP, target: { team: REGISTRAR_TEAM }, members: REGISTRAR_MEMBERS },
  ])
  // The view that Lee and Ana both hold: the instance at the log version that
  // the start produced (I5). Nobody holds the task before a claim (AS-2).
  const opened = state.log.length
  const view: Instance = { ...started.instance, version: opened }
  expect(view.holder).toBeUndefined()

  // (a) AS-2, I5: Lee and Ana both select Claim on that view. Lee's claim is
  // based on the current version, so the engine accepts it, records the holder
  // (I14) and advances the log by one event.
  const lee = claim(view, LEE, opened, sources)
  expect(lee.accepted).toBe(true)
  expect(lee.instance.holder).toBe(LEE)
  expect(lee.operation?.type).toBe(STEP_CLAIMED)
  expect(lee.operation?.actor).toBe(LEE)
  const held = lee.instance.version ?? 0
  const afterLee = applyAction(lee, state)
  expect(held).toBe(opened + 1)
  expect(afterLee.log).toHaveLength(state.log.length + 1)

  // Ana's claim is based on the same view, but Lee's claim advanced the log.
  // The engine refuses it at once and names the holder (I5, AS-2): exactly one
  // claim succeeds, and the other sees that Lee claimed the task just now.
  const ana = claim(lee.instance, ANA, opened, sources)
  expect(ana.accepted).toBe(false)
  expect(ana.operation).toBeUndefined()
  expect(ana.reason).toContain('claimed by user:lee just now')

  // (b) AC-4: the holder completes the task with approve. The engine
  // authorizes the outcome from Lee's grants, so the task advances to the
  // archive step and the holder is cleared.
  const context: CompletionContext = { flow: SLUG, definition, grants: leeGrants }
  const approved = complete(lee.instance, LEE, 'approve', held, context, sources)
  expect(approved.accepted).toBe(true)
  expect(approved.operation?.type).toBe(STEP_COMPLETED)
  expect(approved.instance.holder).toBeUndefined()
  expect(approved.instance.currentStep).toBe(ARCHIVE_STEP)
  expect(approved.instance.done).toBe(false)

  // A different outcome is refused: Lee holds `step.outcome:approve` on the
  // step and no other scope, so the engine authorizes approve and no other
  // outcome (AC-4).
  const refused = complete(lee.instance, LEE, 'reject', held, context, sources)
  expect(refused.accepted).toBe(false)
  expect(refused.operation).toBeUndefined()
  expect(refused.reason).toContain('step.outcome:reject')

  // A principal that is not the holder may not complete the step (AS-2).
  const notHolder = complete(lee.instance, ANA, 'approve', held, context, sources)
  expect(notHolder.accepted).toBe(false)
  expect(notHolder.reason).toContain('does not hold')

  // The last step marks the instance done (S09): with no next step the
  // completion ends the flow.
  const done = complete(
    lee.instance,
    LEE,
    'approve',
    held,
    { flow: SLUG, definition: terminalDefinition, grants: leeGrants },
    sources
  )
  expect(done.accepted).toBe(true)
  expect(done.instance.currentStep).toBeUndefined()
  expect(done.instance.done).toBe(true)

  // (c) I5: Lee's view is stale once his approval advanced the log. A second
  // completion from that view is refused by the version check, so the task is
  // not approved twice.
  const afterApprove = applyAction(approved, afterLee)
  const approvals = (log: State['log']): number =>
    log.filter((event) => event.type === STEP_COMPLETED).length
  expect(approvals(afterApprove.log)).toBe(1)
  const stale = complete(approved.instance, LEE, 'approve', opened, context, sources)
  expect(stale.accepted).toBe(false)
  expect(stale.operation).toBeUndefined()
  expect(stale.instance).toBe(approved.instance)
  expect(stale.reason).toContain('stale')
  expect(approvals(afterApprove.log)).toBe(1)
})
