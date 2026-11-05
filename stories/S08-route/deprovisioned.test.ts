import { expect, test } from 'vitest'
import { STEP_CLAIMED } from '../../engine/action.js'
import { instanceOf } from '../../engine/instances.js'
import { deprovisionedOf, USER_DEPROVISIONED } from '../../engine/membership.js'
import { outboxOf } from '../../engine/outbox.js'
import { unroutableReason } from '../../engine/resolve.js'
import { ALERT_CONNECTOR, UNROUTABLE_ALERT, UNROUTABLE_QUEUE } from '../../engine/routing.js'
import { timeline } from '../../engine/timeline.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import { storyOperators } from '../../tools/harness/suite.js'
import { INSTANCE_ID, OKAFOR, PEOPLE, PRIYA, SAM } from '../example-flow.js'
import {
  DEPROVISIONED_STEP,
  deprovisionedGolden,
  MANAGER_STEP,
  MANAGER_STEP_INDEX,
  managerDefinition,
  managerGolden,
  requiresManager,
} from './scenario.js'

// Issue #267, S08 acceptance, AS-1, AS-4, AS-5, ID-5, I10, I13, I14: a
// `manager-of:starter` target resolves once, at the submit, to the starter's
// manager through the directory (AS-1, I13), and a target that names a
// deprovisioned person resolves to nobody, so the task goes to the Unroutable
// queue and Priya, the flow owner, gets the alert with the reason (ID-5,
// I10). The deprovision is on the log, attributed to Dana (I14). Both paths
// run in api, cli and dry mode, and the engine predicts them (I6).

const fields = managerDefinition.steps.flatMap((step) => step.fields ?? [])
const versioning = {
  actor: 'user:dana',
  slug: 'course-overload',
  definition: managerDefinition,
  started: managerDefinition,
}

test("#267 S08 AS-1 manager-of:starter resolves to the starter's manager at the submit, and the manager claims", async () => {
  await runGolden(managerGolden)
  const { state } = await runModes(managerGolden)
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the request is not projected')
  expect(instance.currentStep).toBe(MANAGER_STEP)
  expect(instance.queue).toBeUndefined()
  expect(instance.assignees).toContainEqual({
    step: MANAGER_STEP,
    target: { 'manager-of': 'starter' },
    members: [OKAFOR],
  })
  expect(instance.holder).toBe(OKAFOR)
  expect(state.log[MANAGER_STEP_INDEX.okaforClaim]).toMatchObject({
    type: STEP_CLAIMED,
    actor: OKAFOR,
  })
})

test('#267 S08 ID-5 I10 a deprovisioned manager routes the task to Unroutable and alerts the owner', async () => {
  await runGolden(deprovisionedGolden)
  const { state, intents } = await runModes(deprovisionedGolden)
  // The deprovision is on the log, attributed to Dana (ID-5, I14), and the
  // log names Dr. Okafor deprovisioned from then on.
  const gone = state.log[DEPROVISIONED_STEP.deprovision]
  expect(gone).toMatchObject({
    type: USER_DEPROVISIONED,
    actor: 'user:dana',
    payload: { principal: OKAFOR, released: [] },
  })
  expect([...deprovisionedOf(state.log)]).toEqual([OKAFOR])

  // Sam's submit resolved his manager to nobody: the task is in the
  // Unroutable queue, the submit records the empty resolution, and the alert
  // to Priya rode in the same operation (AS-5, I10, I2).
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the request is not projected')
  expect(instance.starter).toBe(SAM)
  expect(instance.currentStep).toBe(MANAGER_STEP)
  expect(instance.queue).toBe(UNROUTABLE_QUEUE)
  expect(instance.assignees).toContainEqual({
    step: MANAGER_STEP,
    target: { 'manager-of': 'starter' },
    members: [],
  })
  const alert = {
    operation: UNROUTABLE_ALERT,
    target: ALERT_CONNECTOR,
    payload: { to: PRIYA, step: MANAGER_STEP },
  }
  expect(intents).toContainEqual(alert)
  expect(outboxOf([state.log[DEPROVISIONED_STEP.submit]])).toContainEqual(alert)
  // The reason the timeline gives (AS-5, A8): the manager target resolved to
  // no current principal.
  expect(
    unroutableReason(managerDefinition.steps[1], [
      { step: MANAGER_STEP, target: { 'manager-of': 'starter' }, members: [] },
    ])
  ).toBe(`step ${MANAGER_STEP}: no target resolved to a current principal (manager-of:starter)`)
  const entry = timeline(state.log).find((candidate) => candidate.seq === gone.seq)
  expect(entry).toMatchObject({ actor: 'user:dana', type: USER_DEPROVISIONED })
})

test('#267 S08 the Actor operator does each step of the manager acceptances as each person of the cast', async () => {
  const manager = storyOperators({
    golden: managerGolden,
    people: PEOPLE,
    requires: requiresManager,
    fields,
    versioning,
  })
  const variants = await manager.actor()
  expect(variants).toHaveLength(managerGolden.steps.length * PEOPLE.length)
  // Only Dr. Okafor, the resolved manager, may claim the manager task (AS-1).
  const claims = variants.filter((variant) => variant.stepIndex === MANAGER_STEP_INDEX.okaforClaim)
  expect(claims.filter((variant) => variant.expected === 'reached').map((v) => v.actor)).toEqual([
    OKAFOR,
  ])
  const deprovisioned = storyOperators({
    golden: deprovisionedGolden,
    people: PEOPLE,
    requires: requiresManager,
    fields,
    versioning,
  })
  const gone = await deprovisioned.actor()
  // Only Dana, who holds org.grants, deprovisions (I8).
  const deprovisions = gone.filter(
    (variant) => variant.stepIndex === DEPROVISIONED_STEP.deprovision
  )
  expect(
    deprovisions.filter((variant) => variant.expected === 'reached').map((v) => v.actor)
  ).toEqual(['user:dana'])
  await deprovisioned.duplicate()
})
