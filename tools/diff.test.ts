import { expect, test } from 'vitest'
import { apply, emptyState } from '../engine/apply.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import type { Log } from '../engine/operation.js'

// Issue #264, S03, S04, DF-6, I4, I6, I14: the attributed difference between
// two versions of a flow. Each version shows a field-level difference from
// its parent (DF-6), and the difference names the author of each change
// (S03): the log holds every push and every publication with its actor, so
// the diff reads the net changes between the two points and attributes each
// path to the last push that changed it. A point is a published version
// number or `draft`; the parent of a version is the version before it, and
// the parent of the draft is the newest version. The function is pure (I6).

type Diff = {
  definitionDiff: (
    log: Log,
    slug: string,
    from: number | 'draft' | undefined,
    to: number | 'draft'
  ) =>
    | {
        from: number | 'draft'
        to: number | 'draft'
        changes: readonly { path: string; class: string; actor?: string; at?: number }[]
      }
    | undefined
}

const DIFF_MODULE = new URL('../engine/diff.js', import.meta.url).href

async function diff(): Promise<Diff> {
  return (await import(DIFF_MODULE)) as unknown as Diff
}

const base = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "label": "Sumary", "required": true },
        { "key": "overload_credits", "control": "number", "label": "Overload credits" }
      ]
    },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve"] }
  ]
}`)

function edited(from: FlowDefinition, edit: (doc: { steps: Record<string, unknown>[] }) => void) {
  const doc = JSON.parse(JSON.stringify(from)) as { steps: Record<string, unknown>[] }
  edit(doc)
  return parse(JSON.stringify(doc))
}

const priyaFixesLabel = edited(base, (doc) => {
  ;(doc.steps[0].fields as { label: string }[])[0].label = 'Summary'
})
const danaAddsField = edited(priyaFixesLabel, (doc) => {
  ;(doc.steps[0].fields as unknown[]).push({
    key: 'reason_category',
    control: 'text',
    required: true,
  })
})

/** Version 1 from the base, Priya's label fix, Dana's field, version 2, then Dana's draft edit. */
function flowLog(): Log {
  const deps = (id: string, at: number) => ({ clock: () => at, ids: () => id })
  let flow = createFlow('course-overload')
  const operations = []
  const first = push(flow, base, deps('push-1', 1), 'user:dana')
  flow = first.flow
  operations.push(first.operation)
  const v1 = publish(flow, deps('publish-1', 2), 'user:dana')
  flow = v1.flow
  operations.push(v1.operation)
  const second = push(flow, priyaFixesLabel, deps('push-2', 3), 'user:priya')
  flow = second.flow
  operations.push(second.operation)
  const third = push(flow, danaAddsField, deps('push-3', 4), 'user:dana')
  flow = third.flow
  operations.push(third.operation)
  const v2 = publish(flow, deps('publish-2', 5), 'user:dana')
  flow = v2.flow
  operations.push(v2.operation)
  const danaRenames = edited(danaAddsField, (doc) => {
    doc.steps[1].outcomes = ['approve', 'send_back']
  })
  const fourth = push(flow, danaRenames, deps('push-4', 6), 'user:dana')
  operations.push(fourth.operation)
  let state = emptyState
  for (const operation of operations) state = apply(operation, state)
  return state.log
}

test('#264 DF-6 S03 S04 the difference between two versions names each change and its author', async () => {
  const { definitionDiff } = await diff()
  const log = flowLog()
  const between = definitionDiff(log, 'course-overload', 1, 2)
  expect(between?.from).toBe(1)
  expect(between?.to).toBe(2)
  expect(between?.changes).toEqual([
    expect.objectContaining({
      path: '/steps/request/fields/summary/label',
      class: 'edit',
      actor: 'user:priya',
      at: 3,
    }),
    expect.objectContaining({
      path: '/steps/request/fields/reason_category',
      class: 'structural',
      actor: 'user:dana',
      at: 4,
    }),
  ])
  // The parent of a version is the version before it, and the parent of the
  // draft is the newest version (DF-6).
  expect(definitionDiff(log, 'course-overload', undefined, 2)).toEqual(between)
  const draft = definitionDiff(log, 'course-overload', undefined, 'draft')
  expect(draft?.from).toBe(2)
  expect(draft?.changes).toEqual([
    expect.objectContaining({ path: '/steps/advisor/outcomes', actor: 'user:dana', at: 6 }),
  ])
  // The first version differs from nothing but itself: every step is new.
  const first = definitionDiff(log, 'course-overload', undefined, 1)
  expect(first?.changes.map((change) => change.path)).toEqual(['/steps/request', '/steps/advisor'])
  expect(first?.changes.every((change) => change.actor === 'user:dana')).toBe(true)
  // The same point twice is no change; an unknown version or flow is nothing.
  expect(definitionDiff(log, 'course-overload', 2, 2)?.changes).toEqual([])
  expect(definitionDiff(log, 'course-overload', 1, 7)).toBeUndefined()
  expect(definitionDiff(log, 'other', undefined, 'draft')).toBeUndefined()
})
