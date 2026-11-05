import { expect, test } from 'vitest'
import { contentHash } from '../../engine/instance.js'
import { instanceOf, readInstance } from '../../engine/instances.js'
import { rebindDraft, versionDiff } from '../../engine/version.js'
import { runGolden, runModes } from '../../tools/harness/runner.js'
import {
  definitionV1,
  depsFor,
  grantsOfPerson,
  instanceAfter,
  SAM,
  SLUG,
  versionV1,
} from '../example-flow.js'
import { DRAFT_ID, definitionV2, golden, STEP, SUBMITTED_ID, versionV2 } from './scenario.js'

// Issue #41: adding a field while submissions are in progress (S04). A
// publication freezes the draft into an immutable version with a content hash
// (DF-2), so a request submitted on v1 keeps its definitionVersion when v2 is
// published (I13). A draft that is not submitted rebinds to v2 when Sam opens
// it again: it keeps each value that fits, highlights the new required field,
// and shows the value that does not fit without deleting it (RT-6, A7). The
// difference from v1 to v2 shows the new field (DF-6).

/** The misfits and the new required field the rebind reports (RT-6, A7). */
const MISFITS = [{ key: 'overload_credits', reason: 'the value 2 does not fit the select control' }]
const NEW_REQUIRED = ['reason_category']

test('#41 the S04 golden path runs in api, cli and dry mode: v2 pins nothing submitted and rebinds the draft (S04)', async () => {
  await runGolden(golden)
  const { state } = await runModes(golden)

  // (a) The submitted request stays on v1 with no change (DF-2, I13).
  const submitted = instanceOf(state.log, SUBMITTED_ID)
  expect(submitted?.definitionVersion).toBe(versionV1.contentHash)
  expect(submitted?.submitted).toBe(true)

  // (b) The draft moved to v2, kept every value, and the read carries what
  // Sam must see: the new required field and the value that no longer fits,
  // not deleted (RT-6, A7).
  const draft = instanceOf(state.log, DRAFT_ID)
  expect(draft?.definitionVersion).toBe(versionV2.contentHash)
  expect(draft?.values).toEqual({
    summary: 'three extra credits',
    overload_credits: 2,
    advisor: 'user:okafor',
  })
  if (draft === undefined) throw new Error('the draft is not projected')
  const view = readInstance(SAM, draft, {
    flow: SLUG,
    definition: definitionV2,
    log: state.log,
    grants: grantsOfPerson(SAM),
  })
  expect(view?.rebound).toEqual({
    from: versionV1.contentHash,
    to: versionV2.contentHash,
    misfits: MISFITS,
    newRequired: NEW_REQUIRED,
  })
  // The form's required fields on v2 include the new one; the rebind names
  // the one that still needs an answer (RT-6).
  expect(view?.required).toEqual(['summary', 'overload_credits', 'advisor', 'reason_category'])

  // (c) The difference from v1 to v2 shows the new field (DF-6).
  const diff = versionDiff(versionV1, versionV2)
  expect(diff.length).toBeGreaterThan(0)
  expect(diff.every((change) => change.class === 'structural')).toBe(true)
  expect(diff).toContainEqual({
    class: 'structural',
    message: 'a field was added to step request: reason_category',
    path: '/steps/request/fields/reason_category',
  })
}, 60_000)

test('#41 the rebind keeps the values and reports the misfits, and never touches a submitted request (S04)', () => {
  // The two versions are immutable and distinct (DF-2).
  expect(versionV2.contentHash).toBe(contentHash(definitionV2))
  expect(versionV2.contentHash).not.toBe(contentHash(definitionV1))

  // The rebind of the open draft is the golden step: it keeps the values,
  // names the misfit and the new required field (RT-6, A7).
  const before = golden.steps.slice(0, STEP.rebind)
  const rebound = rebindDraft(instanceAfter(before, DRAFT_ID), SAM, versionV2, depsFor(STEP.rebind))
  expect(rebound.accepted).toBe(true)
  expect(rebound.operation?.payload).toEqual({
    instanceId: DRAFT_ID,
    from: versionV1.contentHash,
    definitionVersion: versionV2.contentHash,
    misfits: MISFITS,
    newRequired: NEW_REQUIRED,
  })
  expect(golden.steps[STEP.rebind].payload).toEqual(rebound.operation?.payload)
  expect(rebound.instance.values).toEqual(instanceAfter(before, DRAFT_ID).values)

  // A submitted request never rebinds (DF-2), and a draft already on the
  // version is a no-op.
  expect(
    rebindDraft(instanceAfter(before, SUBMITTED_ID), SAM, versionV2, depsFor(12)).accepted
  ).toBe(false)
  expect(rebindDraft(rebound.instance, SAM, versionV2, depsFor(12)).accepted).toBe(false)
})
