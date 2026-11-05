import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { instanceOf, readInstance } from '../engine/instances.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #256, RT-6, S04, DF-2, DF-6, A7, I4: a draft that is not submitted
// moves to the newest published version when its starter opens it again. It
// keeps every value that fits, it reports the new required fields and the
// values that no longer fit without deleting them, and a submitted instance
// stays on its version. The rebind is an attributed operation on the log that
// the projection folds (I4).

const SLUG = 'course-overload'
const SAM = 'user:sam'

const v1 = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text" },
        { "key": "credits", "control": "number" },
        { "key": "campus", "control": "select", "options": ["north", "south"] }
      ],
      "editable": ["summary", "credits", "campus"]
    },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] }
  ]
}
`)

/** v2 adds a required field, turns credits into a select and drops campus. */
const v2 = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text" },
        { "key": "credits", "control": "select", "options": ["1", "2"] },
        { "key": "reason_category", "control": "text", "required": true }
      ],
      "editable": ["summary", "credits", "reason_category"]
    },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]
const resolve: TargetResolver = (target) =>
  'starter' in target ? [SAM] : 'user' in target ? [target.user] : []

function deps(id: string, at = 1): OperationDeps {
  return { clock: () => at, ids: () => id }
}

test.fails('#256 RT-6 an open draft rebinds to the new version and reports what does not fit', async () => {
  const { rebindDraft, DRAFT_REBOUND } = (await import('../engine/version.js')) as unknown as {
    rebindDraft: (...args: unknown[]) => {
      accepted: boolean
      instance: { values?: unknown; definitionVersion: string }
      operation?: Operation
    }
    DRAFT_REBOUND: string
  }
  const pushed = push(createFlow(SLUG), v1, deps('push-1'), 'user:dana')
  const published = publish(pushed.flow, deps('publish-1'), 'user:dana')
  let state: State = apply(published.operation, apply(pushed.operation, emptyState))
  const flow = { slug: SLUG, versions: published.flow.versions }

  const draft = startInstance(
    flow,
    'draft-1',
    { summary: 'hi', credits: 3, campus: 'north' },
    SAM,
    deps('op-1'),
    resolve,
    grants
  )
  state = apply(draft.operation, state)
  const submitted = startInstance(
    flow,
    'done-1',
    { summary: 'other' },
    SAM,
    deps('op-2', 2),
    resolve,
    grants
  )
  state = apply(submitted.operation, state)
  const sent = submitInstance(
    submitted.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition: v1, resolve, grants },
    deps('op-3', 3)
  )
  if (sent.operation === undefined) throw new Error(sent.reason)
  state = apply(sent.operation, state)

  // Dana publishes v2.
  const pushed2 = push(published.flow, v2, deps('push-2', 4), 'user:dana')
  const published2 = publish(pushed2.flow, deps('publish-2', 5), 'user:dana')
  state = apply(published2.operation, apply(pushed2.operation, state))
  const versionV2 = published2.flow.versions[1]
  expect(versionV2.contentHash).toBe(contentHash(v2))

  // The rebind of the open draft: the values stay, the misfits and the new
  // required field are named (RT-6, A7).
  const rebound = rebindDraft(
    instanceOf(state.log, 'draft-1') ?? draft.instance,
    SAM,
    versionV2,
    deps('op-4', 6)
  )
  expect(rebound.accepted).toBe(true)
  expect(rebound.operation?.type).toBe(DRAFT_REBOUND)
  expect(rebound.operation?.payload).toEqual({
    instanceId: 'draft-1',
    from: contentHash(v1),
    definitionVersion: contentHash(v2),
    misfits: [
      { key: 'credits', reason: 'the value 3 does not fit the select control' },
      { key: 'campus', reason: 'the field is no longer part of the form' },
    ],
    newRequired: ['reason_category'],
  })
  expect(rebound.instance.values).toEqual({ summary: 'hi', credits: 3, campus: 'north' })
  expect(rebound.instance.definitionVersion).toBe(contentHash(v2))
  state = apply(rebound.operation ?? draft.operation, state)

  // The projection folds the rebind: the draft is on v2 and the read carries
  // what the author must see; the submitted instance stays on v1 (DF-2).
  const moved = instanceOf(state.log, 'draft-1')
  expect(moved?.definitionVersion).toBe(contentHash(v2))
  expect(moved?.values).toEqual({ summary: 'hi', credits: 3, campus: 'north' })
  if (moved === undefined) throw new Error('the draft is not projected')
  const view = readInstance(SAM, moved, {
    flow: SLUG,
    definition: v2,
    log: state.log,
    grants,
  })
  expect((view as unknown as { rebound?: unknown } | undefined)?.rebound).toEqual({
    from: contentHash(v1),
    to: contentHash(v2),
    misfits: [
      { key: 'credits', reason: 'the value 3 does not fit the select control' },
      { key: 'campus', reason: 'the field is no longer part of the form' },
    ],
    newRequired: ['reason_category'],
  })
  expect(view?.required).toEqual(['reason_category'])
  expect(instanceOf(state.log, 'done-1')?.definitionVersion).toBe(contentHash(v1))

  // A submitted instance never rebinds, and a draft already on the version
  // is a no-op.
  expect(
    rebindDraft(instanceOf(state.log, 'done-1') ?? draft.instance, SAM, versionV2, deps('op-5', 7))
      .accepted
  ).toBe(false)
  expect(rebindDraft(moved ?? draft.instance, SAM, versionV2, deps('op-6', 8)).accepted).toBe(false)
})
