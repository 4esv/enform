// Issue #246, S15, VT-5, VT-6, I4, I6, I13: the timeline projection that the
// instance timeline and the change feed serve. One event becomes one entry,
// and the entry carries the step and the comment when the payload carries them,
// the flow when the event names one, and only the operation, time and outcome
// of a connector call. The projection reads no second store (I4).

import { expect, test } from 'vitest'
import type { Event } from '../engine/operation.js'
import {
  CONNECTOR_CALLED,
  flowOf,
  isConfigChange,
  timeline,
  timelineFor,
} from '../engine/timeline.js'

const SAM = 'user:sam'
const SLUG = 'course-overload'
const AT = 1_700_000_000_000

/** One event of the test log, in the one global order (I4). */
function event(seq: number, type: string, payload: Readonly<Record<string, unknown>>): Event {
  return { seq, operationId: `op-${seq}`, type, at: AT + seq * 60_000, actor: SAM, payload }
}

test('#246 VT-5 an entry carries the step and the comment of its payload', () => {
  const log = [
    event(1, 'step.claimed@1', { instanceId: 'inst-1', step: 'request', holder: SAM }),
    event(2, 'step.sent-back@1', {
      instanceId: 'inst-1',
      from: 'advisor',
      to: 'request',
      comment: 'Attach your degree audit',
    }),
  ]

  // A claim carries its step; a send back carries the step it reopens as `to`,
  // which is where the note sits (WF-3, S11).
  expect(timeline(log)).toEqual([
    {
      seq: 1,
      at: AT + 60_000,
      actor: SAM,
      type: 'step.claimed@1',
      step: 'request',
    },
    {
      seq: 2,
      at: AT + 120_000,
      actor: SAM,
      type: 'step.sent-back@1',
      step: 'request',
      comment: 'Attach your degree audit',
    },
  ])
})

test('#246 VT-6 an entry names the flow that its event carries', () => {
  const log = [
    event(1, 'config.flow.title@1', { flow: SLUG, title: 'Course Overload' }),
    event(2, 'config.definition.published@1', { slug: SLUG, version: 1 }),
    event(3, 'config.grant.changed@1', {
      principal: SAM,
      scopes: ['instance.start'],
      resource: `flow:${SLUG}`,
    }),
  ]

  expect(timeline(log).map((entry) => entry.flow)).toEqual([SLUG, SLUG, SLUG])
  expect(log.map((entry) => flowOf(entry))).toEqual([SLUG, SLUG, SLUG])
  expect(log.map((entry) => isConfigChange(entry.type))).toEqual([true, true, true])
  expect(isConfigChange('step.claimed@1')).toBe(false)

  // The feed keeps only the matching entries, in log order (VT-6).
  expect(timelineFor(log, { flow: SLUG, type: 'config.definition.published@1' })).toEqual([
    {
      seq: 2,
      at: AT + 120_000,
      actor: SAM,
      type: 'config.definition.published@1',
      flow: SLUG,
    },
  ])
})

test('#246 I13 a connector call carries no response body', () => {
  const call = {
    operation: 'send-assignment',
    time: AT,
    outcome: 'sent',
    body: { to: 'sam@example.org' },
  }
  const entry = timeline([event(1, CONNECTOR_CALLED, call)])[0]

  expect(entry?.call).toEqual({ operation: 'send-assignment', time: AT, outcome: 'sent' })
  expect(JSON.stringify(entry)).not.toContain('sam@example.org')
})
