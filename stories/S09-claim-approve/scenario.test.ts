import { expect, test } from 'vitest'
import { claim, complete, STEP_COMPLETED } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ANA,
  definitionV1,
  depsFor,
  directory,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  LEE,
  OKAFOR,
  REGISTRAR_MEMBERS,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  SLUG,
} from '../example-flow.js'
import { golden, STEP, values } from './scenario.js'

// Issue #46: the registrar task shows to Lee, Ana and Jordan; two of them
// claim it at the same time and exactly one succeeds (AS-2, I5). The holder
// completes it with approve, which his `step.outcome:approve` grant
// authorizes and no other outcome does (AC-4). A holder with a stale view has
// the completion refused by the version check, so there is no second approval
// (I5). The path is deterministic (I6).

test('#46 the S09 golden path runs in api, cli and dry mode and reaches the golden end state (S09)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)
  // The registrar step resolved to the team's members at the submit (AS-4,
  // I13), Lee claimed and approved it, and the instance is done (S09).
  const instance = instanceOf(state.log, INSTANCE_ID)
  expect(instance?.assignees).toContainEqual({
    step: REGISTRAR_STEP,
    target: { team: REGISTRAR_TEAM },
    members: REGISTRAR_MEMBERS,
  })
  expect(instance?.done).toBe(true)
  expect(state.log.filter((event) => event.type === STEP_COMPLETED)).toHaveLength(2)
})

test('#46 exactly one claim succeeds and the holder completes with an authorized outcome (S09)', () => {
  // The view that Lee and Ana both hold: the instance at the registrar step,
  // at the version that Dr. Okafor's approval produced (I5). Nobody holds the
  // task before a claim (AS-2).
  const opened = golden.steps.slice(0, STEP.leeClaim)
  const view = instanceAfter(opened)
  expect(view.currentStep).toBe(REGISTRAR_STEP)
  expect(view.holder).toBeUndefined()
  const version = view.version ?? 0

  // (a) AS-2, I5: Lee and Ana both select Claim on that view. Lee's claim is
  // based on the current version, so the engine accepts it and records the
  // holder (I14).
  const lee = claim(view, LEE, version, depsFor(STEP.leeClaim))
  expect(lee.accepted).toBe(true)
  expect(lee.instance.holder).toBe(LEE)
  expect(lee.operation?.actor).toBe(LEE)

  // Ana's claim is based on the same view, but Lee's claim advanced the log.
  // The engine refuses it at once and names the holder (I5, AS-2): exactly one
  // claim succeeds, and the other sees that Lee claimed the task just now.
  const ana = claim(lee.instance, ANA, version, depsFor(STEP.leeClaim))
  expect(ana.accepted).toBe(false)
  expect(ana.operation).toBeUndefined()
  expect(ana.reason).toContain('claimed by user:lee just now')

  // (b) AC-4: the holder completes the task with approve. The engine
  // authorizes the outcome from Lee's grants; the registrar step is the last,
  // so the instance is done.
  const held = lee.instance.version ?? 0
  const context = {
    flow: SLUG,
    definition: definitionV1,
    grants: grantsOfPerson(LEE),
    resolve: directory(values),
  }
  const approved = complete(
    lee.instance,
    LEE,
    'approve',
    {},
    held,
    context,
    depsFor(STEP.leeApprove)
  )
  expect(approved.accepted).toBe(true)
  expect(approved.instance.holder).toBeUndefined()
  expect(approved.instance.done).toBe(true)

  // A different outcome is refused: Lee holds approve and reject on the step
  // and not send_back, so the engine authorizes those and no other (AC-4).
  const refused = complete(
    lee.instance,
    LEE,
    'send_back',
    {},
    held,
    context,
    depsFor(STEP.leeApprove)
  )
  expect(refused.accepted).toBe(false)
  expect(refused.reason).toContain('step.outcome:send_back')

  // A principal that is not the holder may not complete the step (AS-2).
  const notHolder = complete(
    lee.instance,
    ANA,
    'approve',
    {},
    held,
    context,
    depsFor(STEP.leeApprove)
  )
  expect(notHolder.accepted).toBe(false)
  expect(notHolder.reason).toContain('does not hold')

  // (c) I5: a holder's view is stale once an approval advanced the log. Dr.
  // Okafor approved the advisor step from his view; a second completion from
  // that same view is refused by the version check before anything else, so
  // the task is not approved twice.
  const okaforView = instanceAfter(golden.steps.slice(0, STEP.okaforApprove))
  const okaforContext = { ...context, grants: grantsOfPerson(OKAFOR) }
  const okaforVersion = okaforView.version ?? 0
  const first = complete(
    okaforView,
    OKAFOR,
    'approve',
    {},
    okaforVersion,
    okaforContext,
    depsFor(STEP.okaforApprove)
  )
  expect(first.accepted).toBe(true)
  const stale = complete(
    first.instance,
    OKAFOR,
    'approve',
    {},
    okaforVersion,
    okaforContext,
    depsFor(STEP.okaforApprove)
  )
  expect(stale.accepted).toBe(false)
  expect(stale.reason).toContain('stale')
})
