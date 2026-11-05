import { expect, test } from 'vitest'
import { authorize } from '../../engine/authorize.js'
import { classifyChange } from '../../engine/edit.js'
import { publish, publishedFlow, push } from '../../engine/flow.js'
import { contentHash } from '../../engine/instance.js'
import { instanceOf } from '../../engine/instances.js'
import { timeline } from '../../engine/timeline.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  DANA,
  definitionV1,
  depsFor,
  FLOW,
  grantsOfPerson,
  INSTANCE_ID,
  PRIYA,
  SLUG,
} from '../example-flow.js'
import { edited, flowV1, golden, priyaGrants, STEP, withField } from './scenario.js'

// Issue #40: Priya holds `flow.edit` and not `flow.build`, so the class of a
// definition change decides whether her push succeeds (DF-5, D2). A label and
// an option are edit-class, so her push and her publication succeed and the
// log attributes them to her (DF-3, DF-5, I14). A change that adds a field is
// structural, so the engine refuses it without `flow.build`, and the message
// names the change and the scope (DF-5, AC-1). A new instance starts on her
// version (DF-2).

test('#40 the S03 golden path runs in api, cli and dry mode: Priya edits a label and an option and publishes (S03)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // Version 2 is Priya's edit, published and attributed to her (DF-3, I14),
  // and the change feed shows the author of each change.
  const published = publishedFlow(state.log, SLUG)
  expect(published?.version).toBe(2)
  expect(published?.contentHash).toBe(contentHash(edited))
  expect(published?.definition).toEqual(edited)
  const feed = timeline(state.log)
  expect(feed.map((entry) => entry.actor).slice(0, 2)).toEqual([DANA, DANA])
  expect(feed[STEP.priyaPush].actor).toBe(PRIYA)
  expect(feed[STEP.priyaPush].flow).toBe(SLUG)
  expect(feed[STEP.priyaPublish].actor).toBe(PRIYA)

  // Sam's instance started on version 2 (DF-2): the newest version pins it.
  expect(instanceOf(state.log, INSTANCE_ID)?.definitionVersion).toBe(contentHash(edited))
}, 60_000)

test('#40 the engine guards an edit-class push and refuses a structural one by its class (S03)', () => {
  // (a) The classification: a label and an option are edit-class; an added
  // field is structural, and each difference names its path (DF-5, DF-6, D2).
  expect(classifyChange(definitionV1, edited)).toEqual([
    {
      class: 'edit',
      message: 'the label of field summary in step request changed',
      path: '/steps/request/fields/summary/label',
      after: 'Summary of your request',
    },
    {
      class: 'edit',
      message: 'an option was added to step advisor: escalate',
      path: '/steps/advisor/outcomes',
      before: ['approve', 'send_back'],
      after: ['approve', 'send_back', 'escalate'],
    },
  ])
  expect(classifyChange(definitionV1, withField).map((change) => change.class)).toEqual([
    'structural',
    'structural',
  ])
  expect(classifyChange(definitionV1, withField)[0]).toEqual({
    class: 'structural',
    message: 'a field was added to step request: reason_category',
    path: '/steps/request/fields/reason_category',
  })

  // (b) AC-1 authorizes against Priya's grants alone: she edits and does not
  // build.
  expect(authorize(priyaGrants, 'flow.edit', FLOW)).toBe(true)
  expect(authorize(priyaGrants, 'flow.build', FLOW)).toBe(false)

  // (c) Priya's edit-class push succeeds and the log attributes it to her
  // (DF-5, I14); it is the golden step.
  const flow = flowV1()
  const change = push(flow, edited, depsFor(STEP.priyaPush), PRIYA, priyaGrants)
  expect(change.flow.draft).toEqual(edited)
  expect(change.operation.actor).toBe(PRIYA)
  expect(golden.steps[STEP.priyaPush].payload).toEqual(change.operation.payload)

  // (d) The same grants cannot make a structural change (DF-5, D2). The
  // refusal names the change and the scope that it needs.
  expect(() => push(flow, withField, depsFor(STEP.priyaPush), PRIYA, priyaGrants)).toThrow(
    /a field was added to step request: reason_category/
  )
  expect(() => push(flow, withField, depsFor(STEP.priyaPush), PRIYA, priyaGrants)).toThrow(
    /flow\.build/
  )
  // A publication is guarded the same way: a structural draft needs flow.build.
  const structural = push(flow, withField, depsFor(STEP.priyaPush), DANA, grantsOfPerson(DANA))
  expect(() => publish(structural.flow, depsFor(STEP.priyaPublish), PRIYA, priyaGrants)).toThrow(
    /flow\.build/
  )

  // (e) Dana holds `flow.build`, so her structural push succeeds (D2), and
  // Priya's edit-class publication succeeds with `flow.edit` alone (DF-3).
  expect(structural.flow.draft).toEqual(withField)
  const released = publish(change.flow, depsFor(STEP.priyaPublish), PRIYA, priyaGrants)
  expect(released.flow.versions.map((version) => version.version)).toEqual([1, 2])
  expect(golden.steps[STEP.priyaPublish].payload).toEqual(released.operation.payload)
})
