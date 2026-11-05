import { expect, test } from 'vitest'
import { instanceOf, readInstance } from '../../engine/instances.js'
import { type GuardedValue, type StatusContext, status, visibleTo } from '../../engine/status.js'
import { trackerOf } from '../../engine/tracker.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ADVISOR_STEP,
  ANA,
  CHAIR_STEP,
  definitionV1,
  FLOW,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  JORDAN,
  LEE,
  OKAFOR,
  PRIYA,
  REGISTRAR_STEP,
  REQUEST_STEP,
  SAM,
  SLUG,
  stateAfter,
} from '../example-flow.js'
import { golden, SEND_BACK_COMMENT, STEP } from './scenario.js'

// Issue #51: Sam reads the status of his own request. The status line is
// step N of M, the current step and its holder, and the state tells
// "waiting to be opened" from "opened, in progress" (VT-1, VT-2). The
// tracker shows every step as not reached, unopened, opened, completed,
// skipped with its reason or sent back with its note (VT-2, S14). Sam reads
// the status but not the notes of the people who act on another step, and
// not the values that a scope guards (VT-3, VT-4, I8). The path is
// deterministic (I6).

/** The skip condition of the chair step (S05, FM-5): the VT-2 reason the tracker shows. */
const chairSkipWhen = definitionV1.steps.find((step) => step.key === CHAIR_STEP)?.skipWhen

/** One value that a scope guards (VT-4): the registrar's internal note, read with instance.timeline. */
const guarded: GuardedValue = {
  key: 'registrar_note',
  value: 'hold until the audit arrives',
  scope: 'instance.timeline',
  resource: FLOW,
}

/** The status read of one person over the golden end state (S14, I8). */
function contextFor(person: string, log: StatusContext['log']): StatusContext {
  return { flow: SLUG, definition: definitionV1, log, grants: grantsOfPerson(person) }
}

/** The tracker states of a prefix of the golden path, by step key (VT-2). */
function trackerAfter(count: number): Record<string, string> {
  const steps = golden.steps.slice(0, count)
  const tracker = trackerOf(instanceAfter(steps), definitionV1, stateAfter(steps).log)
  return Object.fromEntries(tracker.map((entry) => [entry.key, entry.state]))
}

test('#51 the S14 golden path runs in api, cli and dry mode, and the status tells waiting from in progress (S14)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)
  const log = state.log

  // (a) VT-1, VT-2: after the submit the request is at step 2 of 4, the
  // advisor, with no holder: "waiting to be opened". The tracker shows the
  // request completed, the advisor unopened and the rest not reached.
  const submitted = golden.steps.slice(0, STEP.submit + 1)
  const waiting = status(instanceAfter(submitted), definitionV1, stateAfter(submitted).log)
  expect(waiting).toMatchObject({
    step: 2,
    totalSteps: 4,
    currentStep: ADVISOR_STEP,
    state: 'waiting',
  })
  expect(waiting.holder).toBeUndefined()
  expect(trackerAfter(STEP.submit + 1)).toEqual({
    [REQUEST_STEP]: 'completed',
    [ADVISOR_STEP]: 'unopened',
    [CHAIR_STEP]: 'not-reached',
    [REGISTRAR_STEP]: 'not-reached',
  })

  // (b) S05, VT-2: Dr. Okafor's approval skipped the chair step for two
  // credits, and the status names the condition that skipped it.
  const routed = golden.steps.slice(0, STEP.okaforApprove + 1)
  const atRegistrar = status(instanceAfter(routed), definitionV1, stateAfter(routed).log)
  expect(atRegistrar).toMatchObject({ step: 4, currentStep: REGISTRAR_STEP, state: 'waiting' })
  expect(atRegistrar.skipped).toEqual([{ step: CHAIR_STEP, condition: chairSkipWhen }])
  expect(trackerAfter(STEP.okaforApprove + 1)).toEqual({
    [REQUEST_STEP]: 'completed',
    [ADVISOR_STEP]: 'completed',
    [CHAIR_STEP]: 'skipped',
    [REGISTRAR_STEP]: 'unopened',
  })

  // (c) VT-2: Ana's claim makes it "opened, in progress" with her as the
  // holder; her release makes it "waiting to be opened" again.
  const claimed = golden.steps.slice(0, STEP.anaClaim + 1)
  const inProgress = status(instanceAfter(claimed), definitionV1, stateAfter(claimed).log)
  expect(inProgress).toMatchObject({
    currentStep: REGISTRAR_STEP,
    holder: ANA,
    state: 'in-progress',
  })
  expect(trackerAfter(STEP.anaClaim + 1)[REGISTRAR_STEP]).toBe('opened')
  const released = golden.steps.slice(0, STEP.anaRelease + 1)
  const pooled = status(instanceAfter(released), definitionV1, stateAfter(released).log)
  expect(pooled).toMatchObject({ currentStep: REGISTRAR_STEP, state: 'waiting' })
  expect(pooled.holder).toBeUndefined()
  expect(trackerAfter(STEP.anaRelease + 1)[REGISTRAR_STEP]).toBe('unopened')

  // (d) VT-2, WF-3: Jordan's send back returns the request to the advisor;
  // the tracker shows the advisor sent back with the note and keeps the
  // skipped chair with its reason.
  const end = instanceOf(log, INSTANCE_ID)
  if (end === undefined) throw new Error('the golden end state holds no instance')
  expect(status(end, definitionV1, log)).toMatchObject({
    step: 2,
    currentStep: ADVISOR_STEP,
    state: 'waiting',
  })
  const tracker = trackerOf(end, definitionV1, log)
  expect(tracker.map((entry) => [entry.key, entry.state])).toEqual([
    [REQUEST_STEP, 'completed'],
    [ADVISOR_STEP, 'sent-back'],
    [CHAIR_STEP, 'skipped'],
    [REGISTRAR_STEP, 'opened'],
  ])
  expect(tracker.find((entry) => entry.key === ADVISOR_STEP)?.comment).toBe(SEND_BACK_COMMENT)
  expect(tracker.find((entry) => entry.key === CHAIR_STEP)?.condition).toEqual(chairSkipWhen)

  // (e) VT-3, VT-4, I8: Sam reads the status and the tracker of his own
  // instance (AC-5), and not Jordan's note on the advisor step nor the
  // guarded value; Dr. Okafor, who acts on the advisor step, reads the note;
  // Priya, who holds instance.timeline, reads the guarded value; Lee reads
  // the instance as an assignee and not the note; a stranger reads nothing.
  const samRead = readInstance(SAM, end, contextFor(SAM, log))
  expect(samRead?.status.state).toBe('waiting')
  expect(samRead?.tracker.map((entry) => entry.state)).toEqual([
    'completed',
    'sent-back',
    'skipped',
    'opened',
  ])
  const samView = visibleTo(SAM, end, contextFor(SAM, log), [guarded])
  expect(samView.readable).toBe(true)
  expect(samView.notes).toEqual([])
  expect(samView.values).toEqual([])
  const okaforView = visibleTo(OKAFOR, end, contextFor(OKAFOR, log), [guarded])
  expect(okaforView.notes).toEqual([
    { step: ADVISOR_STEP, actor: JORDAN, comment: SEND_BACK_COMMENT },
  ])
  expect(okaforView.values).toEqual([])
  const priyaView = visibleTo(PRIYA, end, contextFor(PRIYA, log), [guarded])
  expect(priyaView.readable).toBe(true)
  expect(priyaView.values).toEqual([guarded])
  const leeView = visibleTo(LEE, end, contextFor(LEE, log), [guarded])
  expect(leeView.readable).toBe(true)
  expect(leeView.notes).toEqual([])
  const stranger = visibleTo('user:stranger', end, contextFor('user:stranger', log), [guarded])
  expect(stranger).toEqual({ readable: false, notes: [], values: [] })
  expect(readInstance('user:stranger', end, contextFor('user:stranger', log))).toBeUndefined()

  // (f) I6: the same inputs give the same view.
  expect(visibleTo(SAM, end, contextFor(SAM, log), [guarded])).toEqual(samView)
}, 60_000)
