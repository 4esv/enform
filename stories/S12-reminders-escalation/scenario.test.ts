import { expect, test } from 'vitest'
import { STEP_COMPLETED } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import { outboxOf } from '../../engine/outbox.js'
import {
  CANCELLED_TIMERS,
  completeBeforeDeadline,
  dueEscalation,
  dueReminders,
  ESCALATION_EMAIL,
  ESCALATION_RULE,
  REMINDER_EMAIL,
  REMINDER_RULE,
  TIMER_FIRED,
} from '../../engine/reminders.js'
import { deliver, sideEffectKey } from '../../engine/sideEffects.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ADVISOR_STEP,
  CHAIRS_GROUP,
  definitionV1,
  directory,
  grantsOfPerson,
  INSTANCE_ID,
  LIN,
  OKAFOR,
  REGISTRAR_STEP,
  SLUG,
} from '../example-flow.js'
import {
  DAY,
  definition,
  ESCALATION_TARGETS,
  golden,
  instanceAt,
  SINCE,
  STEP,
  scheduled,
  stateAt,
  timers,
  values,
} from './scenario.js'

// Issue #49: a task that waits in silence reminds people and then escalates
// (S12). With a one-day reminder interval, one simulated day captures exactly
// one reminder (SE-3, I3), three days capture three reminders and the
// escalation once (SE-4, I3), and a completion before the deadline cancels the
// task's timers in the same event (SE-5, I2). The same timer steps give the
// same side-effect intents dry and live (I7). The path is deterministic (I6).

/** The injected sources of a check (I6). */
const deps = (index: number) => ({ clock: () => SINCE + index, ids: () => `check-${index}` })

test('#49 the S12 golden path runs in api, cli and dry mode: one reminder a day, then the escalation once (S12)', async () => {
  await runGolden(golden)
  const { state, intents } = await runModes(golden)

  // SE-3, I3: exactly one reminder fired within the first day, and one per
  // elapsed day after it; each firing is one event with one side effect
  // whose identity is the instance, the step, the rule and the occurrence.
  const firings = state.log.filter((event) => event.type === TIMER_FIRED)
  expect(firings).toHaveLength(4)
  const reminders = firings.filter((event) => event.payload.kind === 'reminder')
  expect(reminders.filter((event) => event.at <= SINCE + DAY)).toHaveLength(1)
  expect(reminders.map((event) => event.at)).toEqual([
    SINCE + DAY,
    SINCE + 2 * DAY,
    SINCE + 3 * DAY,
  ])
  const sent = outboxOf(state.log).filter((entry) => entry.operation === REMINDER_EMAIL)
  expect(sent.map((entry) => entry.payload.occurrence)).toEqual(['1', '2', '3'])
  expect(
    sent.every((entry) => entry.payload.to === OKAFOR && entry.payload.rule === REMINDER_RULE)
  ).toBe(true)
  expect(new Set(sent.map(sideEffectKey)).size).toBe(3)

  // SE-4, I3: the escalation fired once, at the deadline; it added the
  // CS-Chairs group to the advisor step and kept Okafor as the holder.
  const escalations = outboxOf(state.log).filter((entry) => entry.operation === ESCALATION_EMAIL)
  expect(escalations).toHaveLength(1)
  expect(escalations[0].payload).toMatchObject({
    step: ADVISOR_STEP,
    rule: ESCALATION_RULE,
    occurrence: String(SINCE + 3 * DAY),
    to: OKAFOR,
    adds: ESCALATION_TARGETS,
  })
  const escalated = instanceAt(golden.steps.slice(0, STEP.approve))
  expect(escalated.holder).toBe(OKAFOR)
  expect(escalated.assignees).toContainEqual({
    step: ADVISOR_STEP,
    target: { group: CHAIRS_GROUP },
    members: [LIN],
  })

  // I7: the dry run captured the same intents as the live run, in order: the
  // assignment email, the three reminders, the escalation and the registrar
  // assignments after the approval.
  expect(intents.map((entry) => entry.operation)).toEqual([
    'send-assignment',
    REMINDER_EMAIL,
    REMINDER_EMAIL,
    REMINDER_EMAIL,
    ESCALATION_EMAIL,
    'send-assignment',
    'send-assignment',
    'send-assignment',
  ])
  expect(instanceOf(state.log, INSTANCE_ID)?.currentStep).toBe(REGISTRAR_STEP)
}, 60_000)

test('#49 a timer fires a maximum of one time, and a restart near the deadline fires the escalation once (S12, I3)', () => {
  // The log with every timer fired: a worker that delivered nothing yet
  // delivers the assignment email and the four timers once, in log order.
  const log = stateAt(golden.steps.slice(0, STEP.approve)).log
  const fired = scheduled.map((timer) => timer.entry)
  const all = outboxOf(log)
  expect(all.slice(1)).toEqual(fired)
  expect(deliver(log, new Set())).toEqual(all)
  // A worker that recorded every key delivers nothing again (I3).
  expect(deliver(log, new Set(all.map(sideEffectKey)))).toEqual([])
  // A worker that stops after the reminders and restarts near the deadline
  // delivers the escalation exactly one time (SE-4, I3).
  const delivered = new Set(all.slice(0, 4).map(sideEffectKey))
  expect(deliver(log, delivered)).toEqual([fired[3]])

  // The engine's due checks agree with the firings (SE-3, SE-4, I6).
  const held = instanceAt(golden.steps.slice(0, STEP.reminder1))
  expect(dueReminders(held, timers, SINCE + DAY)).toHaveLength(1)
  expect(dueReminders(held, timers, SINCE + 3 * DAY)).toHaveLength(3)
  expect(dueEscalation(held, timers, SINCE + 3 * DAY - 1)).toBeUndefined()
  expect(dueEscalation(held, timers, SINCE + 3 * DAY)).toEqual(fired[3])
})

test('#49 a completion before the deadline cancels the pending timers in the same event (S12, SE-5, I2)', () => {
  // Dr. Okafor approves after the first reminder, two days before the
  // deadline: the one completion event records the keys of the timers it
  // cancelled, emits no reminder and no escalation, and afterwards no timer of
  // the task is due.
  const held = instanceAt(golden.steps.slice(0, STEP.reminder2))
  const done = completeBeforeDeadline(
    held,
    OKAFOR,
    'approve',
    held.version ?? 0,
    { flow: SLUG, definition, grants: grantsOfPerson(OKAFOR), resolve: directory(values) },
    timers,
    deps(STEP.reminder2)
  )
  expect(done.accepted).toBe(true)
  expect(done.operation?.type).toBe(STEP_COMPLETED)
  const cancelled = scheduled.map((timer) => sideEffectKey(timer.entry))
  expect(done.cancelled.map(sideEffectKey)).toEqual(cancelled)
  expect(done.operation?.payload[CANCELLED_TIMERS]).toEqual(cancelled)
  // The completion carries the registrar step's assignment emails and no
  // timer side effect (SE-5, SE-2).
  const outbox =
    done.operation === undefined
      ? []
      : outboxOf([{ ...done.operation, seq: 1, operationId: done.operation.id }])
  expect(outbox.map((entry) => entry.operation)).toEqual([
    'send-assignment',
    'send-assignment',
    'send-assignment',
  ])
  expect(done.instance.currentStep).toBe(REGISTRAR_STEP)
  expect(
    dueReminders({ ...done.instance, currentStep: undefined }, timers, SINCE + 3 * DAY)
  ).toEqual([])
  // The fixture's definition without timers schedules nothing on the step (SE-3).
  expect(definitionV1.steps[1].reminderMinutes).toBeUndefined()
})
