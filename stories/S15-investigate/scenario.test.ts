import { expect, test } from 'vitest'
import type { Event } from '../../engine/operation.js'
import { INSTANCE_STARTED } from '../../engine/submission.js'
import { CONNECTOR_CALLED, timeline, timelineFor } from '../../engine/timeline.js'
import {
  call,
  DANA,
  EDIT_TYPE,
  GRANT_TYPE,
  investigationLog,
  NOW,
  PUBLISHED_TYPE,
  SAM,
  SLUG,
  STEP,
  SYSTEM,
} from './scenario.js'

/** The six configuration kinds of the story, for the author check (I14). */
const CONFIG_TYPES: readonly string[] = [
  EDIT_TYPE,
  PUBLISHED_TYPE,
  GRANT_TYPE,
  'config.team.changed@1',
  'config.connector.changed@1',
  'config.template.changed@1',
]

// Issue #52: Dana investigates a problem (S15). She reads the timeline of the
// log (I4): the flow edit that Dana made and the instance event that Sam
// caused share one global order (VT-5), each attributed to its author (I14).
// The change feed filters by flow and by type (VT-6), and a connector call
// shows its operation, its time and its outcome and never a response body
// (I13). The projection is pure and deterministic (I6).

test('#52 the timeline merges instance events and configuration changes, attributed and filtered (S15)', () => {
  const entries = timeline(investigationLog())

  // (a) I4, VT-5: the timeline is the log in order, so no two entries have an
  // ambiguous order. Configuration changes and the instance event share the
  // one feed, and every entry carries its event's seq, time and type.
  expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(entries.map((entry) => entry.type)).toEqual([
    EDIT_TYPE,
    PUBLISHED_TYPE,
    GRANT_TYPE,
    'config.team.changed@1',
    'config.connector.changed@1',
    'config.template.changed@1',
    INSTANCE_STARTED,
    CONNECTOR_CALLED,
  ])
  expect(entries.map((entry) => entry.at)).toEqual(
    Array.from({ length: 8 }, (_, index) => NOW + index * STEP)
  )
  for (let index = 1; index < entries.length; index += 1) {
    expect(entries[index].seq).toBeGreaterThan(entries[index - 1].seq)
  }

  // (b) I14, VT-6: the flow edit and the instance event sit on the one order,
  // and each names its author. Every configuration change that affects
  // behavior is attributed (definition, grant, team, connector, template).
  const edit = entries.find((entry) => entry.type === EDIT_TYPE)
  expect(edit?.actor).toBe(DANA)
  const started = entries.find((entry) => entry.type === INSTANCE_STARTED)
  expect(started?.actor).toBe(SAM)
  for (const entry of entries.filter((candidate) => CONFIG_TYPES.includes(candidate.type))) {
    expect(entry.actor, `${entry.type} has no author`).toBe(DANA)
  }

  // (c) VT-6: the change feed filters by flow. The publication names its slug
  // and the grant names its resource `flow:<slug>`, so both stay; a flow that
  // the log does not name returns nothing.
  const byFlow = timelineFor(investigationLog(), { flow: SLUG })
  expect(byFlow.map((entry) => entry.type)).toEqual([PUBLISHED_TYPE, GRANT_TYPE])
  expect(byFlow.every((entry) => entry.flow === SLUG)).toBe(true)
  expect(timelineFor(investigationLog(), { flow: 'other-flow' })).toEqual([])

  // VT-6: the change feed filters by type, and a filter that names both
  // keeps only the entries that match both.
  expect(timelineFor(investigationLog(), { type: EDIT_TYPE }).map((entry) => entry.seq)).toEqual([
    1,
  ])
  const both = timelineFor(investigationLog(), { flow: SLUG, type: GRANT_TYPE })
  expect(both).toHaveLength(1)
  expect(both[0].actor).toBe(DANA)

  // (d) I13: the connector call shows its operation, its time and its outcome,
  // and no response body. A payload that smuggles a body still projects to the
  // three fields only.
  const record = entries.find((entry) => entry.type === CONNECTOR_CALLED)
  expect(record?.call).toEqual(call)
  expect(record?.actor).toBe(SYSTEM)
  const leaked: Event = {
    seq: 1,
    operationId: 'op-leak',
    type: CONNECTOR_CALLED,
    at: call.time,
    actor: SYSTEM,
    payload: {
      operation: call.operation,
      time: call.time,
      outcome: call.outcome,
      body: { to: 'sam@example.org', subject: 'Your request' },
    },
  }
  const redacted = timeline([leaked])
  expect(redacted[0].call).toEqual(call)
  expect(JSON.stringify(redacted)).not.toContain('sam@example.org')

  // (e) I6: the same log gives the same timeline, entry for entry.
  expect(timeline(investigationLog())).toEqual(timeline(investigationLog()))
})
