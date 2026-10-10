import { expect, test } from 'vitest'
import { claim, STEP_COMPLETED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Instance } from '../../engine/instance.js'
import type { Log, OperationDeps } from '../../engine/operation.js'
import { createOutboxOperation, type OutboxEntry, outboxOf } from '../../engine/outbox.js'
import {
  CANCELLED_TIMERS,
  type CompletedTask,
  completeBeforeDeadline,
  dueEscalation,
  dueReminders,
  ESCALATION_EMAIL,
  ESCALATION_RULE,
  REMINDER_EMAIL,
  REMINDER_RULE,
} from '../../engine/reminders.js'
import { runSteps, type Step } from '../../engine/run.js'
import { deliver, sideEffectIdentity, sideEffectKey } from '../../engine/sideEffects.js'
import { EMAIL_CONNECTOR, startInstance } from '../../engine/submission.js'
import {
  ADVISOR_STEP,
  APPROVE,
  DAY,
  data,
  definition,
  ESCALATION_TARGETS,
  flow,
  INSTANCE,
  NOW,
  OKAFOR,
  okaforGrants,
  resolve,
  SLUG,
  STARTER,
  starterGrants,
  timers,
} from './scenario.js'

/** A deterministic ID generator, so two runs of the same steps give the same operations (I6). */
function idGen(): () => string {
  let next = 0
  return () => {
    next += 1
    return `op-${next}`
  }
}

/** The injected sources of the path (I6): the clock and the IDs come from the caller. */
function sources(clock: () => number): OperationDeps {
  return { clock, ids: idGen() }
}

/**
 * A log that already carries the timer side effects that fired (I3). Each timer
 * is one event, so a worker that reads the outbox reads the timers that already
 * occurred.
 */
function fireTimers(log: Log, entries: readonly OutboxEntry[]): Log {
  const ids = idGen()
  let current: State = { applied: new Set(), log }
  for (const entry of entries) {
    const operation = createOutboxOperation(
      'timer.fired@1',
      { instance: INSTANCE, step: ADVISOR_STEP },
      [entry],
      { clock: () => NOW, ids }
    )
    current = apply(operation, current)
  }
  return current.log
}

// Issue #49: a task that waits in silence reminds people and then escalates
// (S12). With a one-day reminder interval, one simulated day captures exactly
// one reminder (SE-3, I3), three days capture three reminders and the
// escalation once (SE-4, I3), and a completion before the deadline cancels the
// task's timers in the same event (SE-5, I2). The same timer steps give the
// same side-effect intents dry and live (I7). The path is deterministic (I6).

test('#49 a stuck task reminds at each interval, escalates at the deadline and cancels its timers (S12)', () => {
  let now = NOW
  const deps = sources(() => now)

  // Sam starts the request; the advisor target resolves to Okafor, so the
  // draft routes to the advisor step (S06, WF-1, I13).
  const started = startInstance(flow, data, STARTER, deps, resolve, starterGrants)
  expect(started.instance.currentStep).toBe(ADVISOR_STEP)
  let state = apply(started.operation, emptyState)

  // Okafor claims the advisor task at NOW, so its idle time starts here (S09).
  const view: Instance = { ...started.instance, version: state.log.length }
  const claimed = claim(view, OKAFOR, view.version ?? 0, deps)
  expect(claimed.accepted).toBe(true)
  if (claimed.operation === undefined) throw new Error(`the claim was refused: ${claimed.reason}`)
  state = apply(claimed.operation, state)
  const held = claimed.instance

  // (a) SE-3, I3: with a one-day interval, one simulated day captures exactly
  // one reminder. Its I3 identity is the instance, the step, the rule and the
  // occurrence.
  now = NOW + DAY
  const oneDay = dueReminders(held, timers, now)
  expect(oneDay).toHaveLength(1)
  expect(oneDay[0]).toEqual({
    operation: REMINDER_EMAIL,
    target: EMAIL_CONNECTOR,
    payload: {
      instance: INSTANCE,
      step: ADVISOR_STEP,
      rule: REMINDER_RULE,
      occurrence: '1',
      to: OKAFOR,
      at: NOW + DAY,
    },
  })
  expect(sideEffectIdentity(oneDay[0])).toEqual({
    operation: REMINDER_EMAIL,
    target: EMAIL_CONNECTOR,
    instance: INSTANCE,
    step: ADVISOR_STEP,
    rule: REMINDER_RULE,
    occurrence: '1',
  })
  // I6: the same inputs give the same timer and the same key.
  expect(dueReminders(held, timers, now)).toEqual(oneDay)
  expect(sideEffectKey(oneDay[0])).toBe(sideEffectKey(dueReminders(held, timers, now)[0]))

  // (b) SE-3, I3: three simulated days capture exactly three reminders, one per
  // elapsed interval, and each occurrence has its own key.
  now = NOW + 3 * DAY
  const threeDays = dueReminders(held, timers, now)
  expect(threeDays.map((entry) => entry.payload.occurrence)).toEqual(['1', '2', '3'])
  const keys = threeDays.map(sideEffectKey)
  expect(new Set(keys).size).toBe(3)

  // (b) SE-4, I3: the escalation is not due before the deadline, it fires once
  // at the deadline, it adds CS-Chairs, and it keeps the current owner.
  expect(dueEscalation(held, timers, now - 1)).toBeUndefined()
  const escalation = dueEscalation(held, timers, now)
  if (escalation === undefined) throw new Error('the escalation did not fire at the deadline')
  expect(escalation).toEqual({
    operation: ESCALATION_EMAIL,
    target: EMAIL_CONNECTOR,
    payload: {
      instance: INSTANCE,
      step: ADVISOR_STEP,
      rule: ESCALATION_RULE,
      occurrence: String(NOW + 3 * DAY),
      to: OKAFOR,
      adds: ESCALATION_TARGETS,
    },
  })
  expect(held.holder).toBe(OKAFOR)
  // A worker records the keys that it delivered, so a restart near the deadline
  // delivers the escalation once and no reminder a second time (I3).
  const fired = [...threeDays, escalation]
  const timerLog = fireTimers(state.log, fired)
  expect(deliver(timerLog, new Set())).toEqual(fired)
  expect(deliver(timerLog, new Set(fired.map(sideEffectKey)))).toEqual([])
  expect(deliver(timerLog, new Set(keys))).toEqual([escalation])

  // (c) SE-5, I2: the task completes before the deadline. The completion
  // cancels the pending timers in the same event, emits no reminder and no
  // escalation, and after the one apply no timer of the task is due.
  const done: CompletedTask = completeBeforeDeadline(
    held,
    OKAFOR,
    APPROVE,
    held.version ?? 0,
    { flow: SLUG, definition, grants: okaforGrants },
    timers,
    deps
  )
  expect(done.accepted).toBe(true)
  expect(done.operation?.type).toBe(STEP_COMPLETED)
  if (done.operation === undefined) throw new Error(`the completion was refused: ${done.reason}`)
  // The completion records the keys of the timers that it cancelled, in the one
  // event (SE-5, I2).
  expect(done.cancelled).toEqual(fired)
  expect(done.operation.payload[CANCELLED_TIMERS]).toEqual(fired.map(sideEffectKey))
  // It emits no timer side effect (SE-5).
  expect(done.operation.payload.outbox).toBeUndefined()
  const after = apply(done.operation, state)
  expect(outboxOf(after.log)).toEqual([])
  // The task is no longer open, so none of its timers is due any more (SE-5).
  expect(done.instance.currentStep).toBeUndefined()
  expect(dueReminders(done.instance, timers, NOW + 3 * DAY)).toEqual([])
  expect(dueEscalation(done.instance, timers, NOW + 3 * DAY)).toBeUndefined()

  // (d) I7: the same timer steps run dry and live give the same side-effect
  // intents, and a live run commits them with the state change (I2).
  const steps: readonly Step[] = fired.map((entry) => ({
    type: 'timer.fired@1',
    payload: { instance: INSTANCE, step: ADVISOR_STEP },
    outbox: [entry],
  }))
  const live = runSteps(steps, { clock: () => NOW, ids: idGen(), sink: 'live' })
  const dry = runSteps(steps, { clock: () => NOW, ids: idGen(), sink: 'dry' })
  expect(live.intents).toEqual(fired)
  expect(dry.intents).toEqual(live.intents)
  expect(outboxOf(live.state.log)).toEqual(fired)
  expect(dry.state.log).toEqual([])
})
