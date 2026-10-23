// Issue #248, S12, SE-3, SE-4, SE-5, I2, I3, I6: the timers that a step
// schedules. The engine reads the interval, the deadline and the escalation
// targets from the step and answers one reminder per interval, the escalation
// at the deadline and, for a step without a deadline, the next reminder. Each
// timer carries its own I3 key, so the same step always gives the same rows,
// and a reminder after the deadline is never scheduled (SE-4). The
// `timer.fired@1` schema agrees with the payload the worker writes.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, test } from 'vitest'
import type { FlowStep } from '../engine/definition.js'
import {
  assigneesAddedBy,
  ESCALATION_EMAIL,
  MINUTE_MS,
  nextReminderTimer,
  REMINDER_EMAIL,
  REMINDER_RULE,
  type ScheduledTimer,
  TIMER_FIRED,
  timersOfStep,
} from '../engine/reminders.js'
import { sideEffectKey } from '../engine/sideEffects.js'

const REPO = join(import.meta.dirname, '..')
const INSTANCE = 'inst-1'
const SINCE = 1_700_000_000_000
const OKAFOR = 'user:okafor'

/** The advisor step of the story: a 30 minute reminder before a 2 hour deadline (SE-3, SE-4). */
const advisor: FlowStep = {
  key: 'advisor',
  targets: [{ user: OKAFOR }],
  outcomes: ['approve'],
  reminderMinutes: 30,
  deadlineMinutes: 120,
  escalationTargets: [{ team: 'CS-Chairs' }],
}

/** The timers of one step, with its one task identity and start (SE-3, SE-4). */
function timers(step: FlowStep = advisor): readonly ScheduledTimer[] {
  return timersOfStep(step, { instance: INSTANCE, since: SINCE, to: OKAFOR })
}

test('#248 SE-3 SE-4 a step schedules one reminder per interval and its escalation', () => {
  const scheduled = timers()
  expect(scheduled.map((timer) => timer.kind)).toEqual([
    'reminder',
    'reminder',
    'reminder',
    'reminder',
    'escalation',
  ])
  expect(scheduled.map((timer) => timer.fireAt)).toEqual([
    SINCE + 30 * MINUTE_MS,
    SINCE + 60 * MINUTE_MS,
    SINCE + 90 * MINUTE_MS,
    SINCE + 120 * MINUTE_MS,
    SINCE + 120 * MINUTE_MS,
  ])

  // The reminders carry the reminder rule and their occurrence; the escalation
  // carries the deadline and the targets it adds (SE-3, SE-4).
  expect(scheduled[0]?.entry).toEqual({
    operation: REMINDER_EMAIL,
    target: 'connector-smtp',
    payload: {
      instance: INSTANCE,
      step: 'advisor',
      rule: REMINDER_RULE,
      occurrence: '1',
      to: OKAFOR,
      at: SINCE + 30 * MINUTE_MS,
    },
  })
  expect(scheduled[4]?.entry.operation).toBe(ESCALATION_EMAIL)
  expect(scheduled[4]?.entry.payload).toMatchObject({
    rule: 'escalation',
    occurrence: String(SINCE + 120 * MINUTE_MS),
    adds: ['team:CS-Chairs'],
  })

  // I3, I6: each timer has its own deterministic key, and the same settings
  // give the same rows.
  const keys = scheduled.map((timer) => sideEffectKey(timer.entry))
  expect(new Set(keys).size).toBe(5)
  expect(timers().map((timer) => sideEffectKey(timer.entry))).toEqual(keys)
})

test('#248 SE-3 SE-4 a step with only an interval keeps reminding until it completes', () => {
  const step: FlowStep = { key: 'advisor', targets: [{ user: OKAFOR }], reminderMinutes: 30 }
  expect(timers(step).map((timer) => timer.kind)).toEqual(['reminder'])

  const next = nextReminderTimer(step, { instance: INSTANCE, since: SINCE, to: OKAFOR }, 2)
  expect(next?.fireAt).toBe(SINCE + 60 * MINUTE_MS)
  expect(next?.entry.payload.occurrence).toBe('2')
  expect(timers({ key: 'request', targets: [{ starter: 'starter' }] })).toEqual([])
})

test('#248 I3 I6 a reminder interval longer than the deadline schedules no reminder', () => {
  const step: FlowStep = {
    key: 'advisor',
    targets: [{ user: OKAFOR }],
    reminderMinutes: 120,
    deadlineMinutes: 60,
  }
  expect(timers(step).map((timer) => timer.kind)).toEqual(['escalation'])
})

test('#248 SE-4 a user and a team add resolve to the principals that the escalation names', () => {
  const membership = (principal: string): readonly string[] =>
    principal === 'CS-Chairs' ? ['user:okafor', 'user:lee'] : []
  const added = assigneesAddedBy(
    'advisor',
    ['user:okafor', 'team:CS-Chairs', 'group:staff'],
    membership
  )
  expect(added).toEqual([
    { step: 'advisor', target: { user: 'okafor' }, members: ['okafor'] },
    {
      step: 'advisor',
      target: { team: 'CS-Chairs' },
      members: ['user:okafor', 'user:lee'],
    },
    // The group directory is not in this lane, so the target stays recorded and
    // adds no principal (the stated gap).
    { step: 'advisor', target: { group: 'staff' }, members: [] },
  ])
})

test('#248 I2 I3 the timer.fired@1 schema matches the worker payload', () => {
  const schema = JSON.parse(
    readFileSync(join(REPO, 'schemas', 'events', 'timer.fired@1.json'), 'utf8')
  )
  const validate = new Ajv2020({ logger: false }).compile(schema)
  const timer = timers()[0]
  if (timer === undefined) throw new Error('the advisor step schedules no timer')
  const payload = {
    timerId: sideEffectKey(timer.entry),
    instanceId: INSTANCE,
    step: 'advisor',
    kind: timer.kind,
    fireAt: timer.fireAt,
    outbox: [timer.entry],
  }
  expect(TIMER_FIRED).toBe('timer.fired@1')
  expect(validate(payload), 'the worker payload validates').toBe(true)
  expect(validate({ ...payload, timerId: undefined }), 'the timer id is required').toBe(false)
  expect(validate({ ...payload, kind: 'other' }), 'the kind is a reminder or an escalation').toBe(
    false
  )
  expect(validate({ ...payload, outbox: [] }), 'a firing carries one side effect').toBe(false)
})
