import { expect, test } from 'vitest'
import { instanceOf } from '../../engine/instances.js'
import { outboxOf } from '../../engine/outbox.js'
import { STEP_TAKEN_OVER, TAKEOVER_NOTIFICATION, takeover } from '../../engine/takeover.js'
import { EVENT_UNDONE, undoAction } from '../../engine/undo.js'
import { predict } from '../../tools/harness/predict.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ANA,
  definitionV1,
  grantsOfPerson,
  INSTANCE_ID,
  LEE,
  PRIYA,
  SAM,
  SLUG,
} from '../example-flow.js'
import {
  clock,
  golden,
  HOUR,
  IDLE_PERIOD,
  instanceAt,
  REASON,
  STEP,
  stateAt,
  TAKEN_STEP,
  UNDO_REASON,
} from './scenario.js'

// Issue #47: Lee claimed the registrar task and went on vacation. Ana, an
// assignee of the step, takes it over after the idle period, and the engine
// records who took it, from whom, when and why and notifies Lee (AS-3, WF-5,
// I14, I2). Below the idle period the engine refuses with the remaining time
// (AS-3). Lee, or Priya with task.reassign, undoes the takeover (WF-5, A1,
// A2). The path is deterministic (I6).

/** Ten minutes: Lee was active this long ago, below the four-hour idle period (AS-3). */
const TEN_MINUTES = 10 * 60 * 1000

/** The injected sources of a check (I6). */
const deps = (index: number) => ({ clock: () => clock(index), ids: () => `check-${index}` })

test('#47 the S10 golden path runs in api, cli and dry mode: the takeover and its undo (S10)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // The timeline records the takeover (I14): one attributed event, from Lee
  // to Ana, when and why, with the notification to Lee in the same event
  // (I2, SE-2).
  const taken = state.log.find((event) => event.type === STEP_TAKEN_OVER)
  expect(taken?.actor).toBe(ANA)
  expect(taken?.payload).toMatchObject({
    instanceId: INSTANCE_ID,
    step: TAKEN_STEP,
    from: LEE,
    to: ANA,
    when: clock(STEP.takeover),
    why: REASON,
  })
  expect(outboxOf(state.log)).toContainEqual({
    operation: TAKEOVER_NOTIFICATION,
    target: 'connector-smtp',
    payload: { to: LEE, step: TAKEN_STEP, actor: ANA, reason: REASON },
  })

  // The undo is a compensating event (A2, I4): the takeover stays in the log,
  // and the projection restores Lee as the holder without an administrator.
  const undone = state.log.find((event) => event.type === EVENT_UNDONE)
  expect(undone?.actor).toBe(LEE)
  expect(undone?.payload).toMatchObject({ eventId: taken?.seq, reason: UNDO_REASON })
  expect(state.log.filter((event) => event.type === STEP_TAKEN_OVER)).toHaveLength(1)
  expect(instanceOf(state.log, INSTANCE_ID)?.holder).toBe(LEE)
}, 60_000)

test('#47 the engine refuses a takeover while the holder was active, with the remaining time (S10)', () => {
  // The view after Lee's claim: the registrar task is his (AS-2).
  const opened = golden.steps.slice(0, STEP.takeover)
  const held = instanceAt(opened)
  const log = stateAt(opened).log
  expect(held.holder).toBe(LEE)
  const version = held.version ?? 0

  // (a) AS-3: Lee was active ten minutes ago, below the four-hour idle
  // period, so the engine refuses Ana's takeover and names the remaining time.
  const tooSoon = takeover(
    held,
    ANA,
    REASON,
    clock(STEP.leeClaim) + TEN_MINUTES,
    IDLE_PERIOD,
    version,
    log,
    deps(STEP.takeover)
  )
  expect(tooSoon.accepted).toBe(false)
  expect(tooSoon.operation).toBeUndefined()
  expect(tooSoon.reason).toContain(String(IDLE_PERIOD - TEN_MINUTES))

  // The server measures the idle time on its clock (AS-3): the same intent
  // posted ten minutes after the claim is refused as 409 with the remaining
  // time, and the story's run stops there.
  const early = {
    ...golden,
    clock: (index: number) =>
      index >= STEP.takeover
        ? clock(STEP.leeClaim) + TEN_MINUTES + (index - STEP.takeover)
        : clock(index),
  }
  const outcome = predict(early).outcomes[STEP.takeover]
  expect('error' in outcome && outcome.status).toBe(409)
  expect('error' in outcome && outcome.error).toContain(String(IDLE_PERIOD - TEN_MINUTES))

  // (b) I5: a takeover based on the stale view, the version before the claim,
  // is refused at once, so the reassign happens once.
  const stale = takeover(
    held,
    ANA,
    REASON,
    clock(STEP.takeover),
    IDLE_PERIOD,
    version - 1,
    log,
    deps(STEP.takeover)
  )
  expect(stale.accepted).toBe(false)
  expect(stale.reason).toContain('stale')

  // AS-3: only an assignee of the step may take it over, and only a claimed
  // task has a holder to take over from.
  const outsider = takeover(
    held,
    SAM,
    REASON,
    clock(STEP.takeover),
    IDLE_PERIOD,
    version,
    log,
    deps(STEP.takeover)
  )
  expect(outsider.accepted).toBe(false)
  expect(outsider.reason).toContain('not an assignee')
  // The holder already has the task: a takeover from himself is refused (AS-3).
  const self = takeover(
    held,
    LEE,
    REASON,
    clock(STEP.takeover),
    IDLE_PERIOD,
    version,
    log,
    deps(STEP.takeover)
  )
  expect(self.accepted).toBe(false)
  expect(self.reason).toContain('already holds')
  const unclaimed = instanceAt(golden.steps.slice(0, STEP.leeClaim))
  const nobody = takeover(
    unclaimed,
    ANA,
    REASON,
    clock(STEP.takeover),
    IDLE_PERIOD,
    unclaimed.version ?? 0,
    log,
    deps(STEP.takeover)
  )
  expect(nobody.accepted).toBe(false)
  expect(nobody.reason).toContain('not claimed')
})

test('#47 Lee, or Priya with task.reassign, can undo the takeover, and nobody else (S10)', () => {
  const taken = golden.steps.slice(0, STEP.undo)
  const instance = instanceAt(taken)
  const log = stateAt(taken).log
  const takeoverSeq = log[log.length - 1].seq
  const context = (actor: string) => ({
    flow: SLUG,
    definition: definitionV1,
    log,
    grants: grantsOfPerson(actor),
    now: clock(STEP.undo),
    undoPeriod: 24 * HOUR,
  })
  const undoBy = (actor: string) =>
    undoAction(
      instance,
      actor,
      takeoverSeq,
      UNDO_REASON,
      instance.version ?? 0,
      context(actor),
      deps(STEP.undo)
    )

  // Priya holds task.reassign on the flow, so she may undo it (WF-5).
  expect(undoBy(PRIYA).accepted).toBe(true)
  // Lee, the previous holder, may undo it: that is the story's point (S10).
  expect(undoBy(LEE).accepted).toBe(true)
  // Sam neither made the takeover nor owns the flow: 403 (I8).
  const sam = undoBy(SAM)
  expect(sam.accepted).toBe(false)
  expect(sam.status).toBe(403)
})
