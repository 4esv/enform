import { expect, test } from 'vitest'
import { STEP_COMPLETED } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import { outboxOf } from '../../engine/outbox.js'
import { refreshAssignees, unroutableReason } from '../../engine/resolve.js'
import { ALERT_CONNECTOR, UNROUTABLE_ALERT, UNROUTABLE_QUEUE } from '../../engine/routing.js'
import { mayRead } from '../../engine/status.js'
import { teamMembership } from '../../engine/teams.js'
import { timeline } from '../../engine/timeline.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  ADVISOR_STEP,
  ANA,
  grantsOfPerson,
  INSTANCE_ID,
  instanceAfter,
  OKAFOR,
  PRIYA,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  SLUG,
  stateAfter,
} from '../example-flow.js'
import {
  ARCHIVE_STEP,
  ARCHIVE_TEAM,
  definition,
  golden,
  INITIAL_REGISTRARS,
  STEP,
} from './scenario.js'

// Issue #45: route each task to real, current people (S08). A dynamic target
// resolves once, at the submit, with a snapshot (AS-1, I13). A team resolves
// live: when Ana joins registrar-office while the task is open, a read shows
// the task to her with no new publication (AS-4). A step whose team holds
// nobody goes to the Unroutable queue, with an alert to the flow owner and a
// reason on the timeline (I10, AS-5). The path is deterministic (I6).

test('#45 the S08 golden path runs in api, cli and dry mode: tasks reach current people or Unroutable (S08)', {
  timeout: 60_000,
}, async () => {
  await runGolden(golden)
  const { state, intents } = await runModes(golden)
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the request is not projected')

  // (a) AS-1, I13: the advisor field resolved to Dr. Okafor at the submit,
  // and the instance records that snapshot.
  expect(instance.assignees).toContainEqual({
    step: ADVISOR_STEP,
    target: { field: 'advisor' },
    members: [OKAFOR],
  })

  // (b) AS-4: the registrar step recorded the team's members at Dr.
  // Okafor's approval, Lee and Jordan, the membership snapshot (I13).
  expect(instance.assignees).toContainEqual({
    step: REGISTRAR_STEP,
    target: { team: REGISTRAR_TEAM },
    members: INITIAL_REGISTRARS,
  })

  // (c) AS-5, I10: Lee's approval entered the archive step, whose team holds
  // nobody: the task is in the Unroutable queue, the completion records the
  // empty resolution, and the alert to Priya rode in the same operation (I2).
  expect(instance.currentStep).toBe(ARCHIVE_STEP)
  expect(instance.queue).toBe(UNROUTABLE_QUEUE)
  const archived = state.log[STEP.leeApprove]
  expect(archived.type).toBe(STEP_COMPLETED)
  expect(archived.payload).toMatchObject({
    currentStep: ARCHIVE_STEP,
    queue: UNROUTABLE_QUEUE,
    assignees: [{ step: ARCHIVE_STEP, target: { team: ARCHIVE_TEAM }, members: [] }],
  })
  const alert = {
    operation: UNROUTABLE_ALERT,
    target: ALERT_CONNECTOR,
    payload: { to: PRIYA, step: ARCHIVE_STEP },
  }
  expect(intents).toContainEqual(alert)
  expect(outboxOf([archived])).toContainEqual(alert)
  expect(
    unroutableReason(definition.steps[3], [
      { step: ARCHIVE_STEP, target: { team: ARCHIVE_TEAM }, members: [] },
    ])
  ).toBe(`step ${ARCHIVE_STEP}: no target resolved to a current principal (team:${ARCHIVE_TEAM})`)
  // The timeline carries the approval that left the task unroutable, in the
  // one global order (I4, VT-5): the step Lee completed, attributed to him.
  const entry = timeline(state.log).find((candidate) => candidate.seq === archived.seq)
  expect(entry).toMatchObject({ actor: 'user:lee', type: STEP_COMPLETED, step: REGISTRAR_STEP })
})

test('#45 a team target resolves live: Ana joins while the task is open and may read it with no publication (S08)', () => {
  // The instance at the registrar step, after Ana's join and before Lee's
  // claim (AS-4). The recorded snapshot names Lee and Jordan; the team now
  // holds Ana too, and the definition and its version are unchanged.
  const steps = golden.steps.slice(0, STEP.leeClaim)
  const instance = instanceAfter(steps)
  const log = stateAfter(steps).log
  expect(instance.currentStep).toBe(REGISTRAR_STEP)
  expect(instance.assignees).toContainEqual({
    step: REGISTRAR_STEP,
    target: { team: REGISTRAR_TEAM },
    members: INITIAL_REGISTRARS,
  })
  const membership = teamMembership(log)
  expect(membership(REGISTRAR_TEAM)).toEqual([...INITIAL_REGISTRARS, ANA])
  const refreshed = refreshAssignees(instance.assignees, membership)
  expect(refreshed).toContainEqual({
    step: REGISTRAR_STEP,
    target: { team: REGISTRAR_TEAM },
    members: [...INITIAL_REGISTRARS, ANA],
  })
  // The advisor field keeps its snapshot through the refresh (AS-1, I13).
  expect(refreshed).toContainEqual({
    step: ADVISOR_STEP,
    target: { field: 'advisor' },
    members: [OKAFOR],
  })
  expect(instance.definitionVersion).toBe(golden.steps[1].payload.contentHash)

  // The read through the live resolver shows Ana the task (AS-4, I8); the
  // recorded instance alone does not, and she holds no read scope.
  const context = { flow: SLUG, definition, log, grants: grantsOfPerson(ANA) }
  expect(mayRead(ANA, { ...instance, assignees: refreshed }, context)).toBe(true)
  expect(mayRead(ANA, instance, context)).toBe(false)
})
