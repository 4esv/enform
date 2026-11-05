import { expect, test } from 'vitest'
import { STEP_CLAIMED, STEP_COMPLETED } from '../../engine/action.js'
import { DEFINITION_CHANGED } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED } from '../../engine/flow.js'
import { GRANT_CHANGE_TYPE } from '../../engine/grants.js'
import { contentHash } from '../../engine/instance.js'
import { instanceOf } from '../../engine/instances.js'
import { readableLog } from '../../engine/logRead.js'
import type { Event } from '../../engine/operation.js'
import { INSTANCE_STARTED, INSTANCE_SUBMITTED } from '../../engine/submission.js'
import { TEAM_CHANGE_TYPE } from '../../engine/teams.js'
import { CONNECTOR_CALLED, isConfigChange, timeline, timelineFor } from '../../engine/timeline.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ANA,
  DANA,
  definitionV1,
  grantsOfPerson,
  INSTANCE_ID,
  LEE,
  PRIYA,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  SAM,
  SLUG,
} from '../example-flow.js'
import { golden, STEP } from './scenario.js'

// Issue #52: Dana reads what changed and when, next to what occurred. The
// timeline is the log in order (I4): instance events and configuration
// changes share one global order, each change names its author (I14, VT-5),
// the change feed filters by flow and by type (VT-6), the authorized log read
// shows each person only what it may read (I8), and a connector call shows
// its operation, its time and its outcome and never a response body (I13).
// The path is deterministic (I6).

test('#52 the S15 golden path runs in api, cli and dry mode: changes and events share one attributed order (S15)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)
  const log = state.log
  const entries = timeline(log)

  // (a) I4, VT-5: the timeline is the log in order, so no two entries have an
  // ambiguous order; the setup, Sam's events, Dana's four changes and Dr.
  // Okafor's actions follow each other by seq.
  expect(entries.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1))
  expect(entries.map((entry) => entry.type).slice(STEP.start)).toEqual([
    INSTANCE_STARTED,
    INSTANCE_SUBMITTED,
    DEFINITION_CHANGED,
    DEFINITION_PUBLISHED,
    GRANT_CHANGE_TYPE,
    TEAM_CHANGE_TYPE,
    STEP_CLAIMED,
    STEP_COMPLETED,
  ])

  // (b) I14, VT-6: every configuration change names its author, Dana; the
  // instance events name Sam and Dr. Okafor.
  for (const entry of entries.filter((candidate) => isConfigChange(candidate.type))) {
    expect(entry.actor, `${entry.type} has no author`).toBe(DANA)
  }
  expect(entries[STEP.start].actor).toBe(SAM)
  expect(entries[STEP.okaforApprove].actor).toBe('user:okafor')

  // (c) VT-6: the change feed filters by flow and by type. The publications,
  // the grants on the flow and the instance events name the flow; the team
  // change names none, so a flow filter drops it.
  const byFlow = timelineFor(log, { flow: SLUG })
  expect(byFlow.every((entry) => entry.flow === SLUG)).toBe(true)
  expect(byFlow.map((entry) => entry.type)).not.toContain(TEAM_CHANGE_TYPE)
  expect(byFlow.map((entry) => entry.type)).toContain(DEFINITION_PUBLISHED)
  expect(byFlow.map((entry) => entry.type)).toContain(GRANT_CHANGE_TYPE)
  expect(timelineFor(log, { flow: 'other-flow' })).toEqual([])
  expect(timelineFor(log, { type: DEFINITION_PUBLISHED }).map((entry) => entry.seq)).toEqual([
    2,
    STEP.publishV2 + 1,
  ])

  // (d) DF-2, AS-4, I13: the instance in progress stays on version 1 while
  // version 2 is published, and the registrar task resolved to the team as
  // the log held it after Jordan left.
  const instance = instanceOf(log, INSTANCE_ID)
  expect(instance?.definitionVersion).toBe(contentHash(definitionV1))
  expect(instance?.currentStep).toBe(REGISTRAR_STEP)
  expect(instance?.assignees).toContainEqual({
    step: REGISTRAR_STEP,
    target: { team: REGISTRAR_TEAM },
    members: [LEE, ANA],
  })

  // (e) I8, VT-5: the authorized log read. Dana, with org.grants, reads the
  // whole log; Priya, with instance.read and instance.timeline on the flow,
  // reads the instance events and the flow's configuration changes and not
  // the team change; Sam reads the events of his own instance only.
  const types = (events: readonly Event[]) => events.map((event) => event.type)
  expect(readableLog(log, DANA, { grants: grantsOfPerson(DANA) })).toHaveLength(log.length)
  const priya = types(readableLog(log, PRIYA, { grants: grantsOfPerson(PRIYA) }))
  expect(priya).toContain(INSTANCE_STARTED)
  expect(priya).toContain(STEP_COMPLETED)
  expect(priya).toContain(DEFINITION_PUBLISHED)
  expect(priya).toContain(GRANT_CHANGE_TYPE)
  expect(priya).not.toContain(TEAM_CHANGE_TYPE)
  const sam = readableLog(log, SAM, { grants: grantsOfPerson(SAM) })
  expect(sam.every((event) => event.payload.instanceId === INSTANCE_ID)).toBe(true)
  expect(types(sam)).toEqual([INSTANCE_STARTED, INSTANCE_SUBMITTED, STEP_CLAIMED, STEP_COMPLETED])

  // (f) I6: the same log gives the same timeline, entry for entry.
  expect(timeline(log)).toEqual(entries)
}, 60_000)

test('#52 I13 a connector call shows its operation, its time and its outcome, and never a response body (S15)', () => {
  // The worker records a call; a payload that smuggles a body still projects
  // to the three fields only.
  const call = { operation: 'send-assignment', time: 1_700_000_000_000, outcome: 'sent' }
  const leaked: Event = {
    seq: 1,
    operationId: 'op-leak',
    type: CONNECTOR_CALLED,
    at: call.time,
    actor: 'system',
    payload: { ...call, body: { to: 'sam@example.org', subject: 'Your request' } },
  }
  const redacted = timeline([leaked])
  expect(redacted[0].call).toEqual(call)
  expect(JSON.stringify(redacted)).not.toContain('sam@example.org')
})
