import { expect, test } from 'vitest'
import { apply, emptyState } from '../engine/apply.js'
import type { JsonValue } from '../engine/definition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import type { Log } from '../engine/operation.js'

// Issue #264, S03, DF-3, I1, I4, I6: two people edit one draft at the same
// time and nobody is blocked. The engine merges the two writes three ways:
// the base is the draft each writer read, ours is the write that arrives
// second, theirs is the draft the first write left. A change that only one
// side made lands; the same place changed differently on both sides is a
// conflict that names its path, and the merge then gives no definition. A
// writer names the base by its content hash, and the log holds every draft
// a push or a publication recorded, so the base is read back from the log
// (I4). Both functions are pure (I6).

type Merge = {
  mergeDefinitions: (
    base: FlowDefinition,
    ours: FlowDefinition,
    theirs: FlowDefinition
  ) => {
    definition?: FlowDefinition
    conflicts: readonly { path: string; base?: JsonValue; ours?: JsonValue; theirs?: JsonValue }[]
  }
  definitionByHash: (log: Log, slug: string, hash: string) => FlowDefinition | undefined
}

const MERGE_MODULE = new URL('../engine/merge.js', import.meta.url).href

async function merge(): Promise<Merge> {
  return (await import(MERGE_MODULE)) as unknown as Merge
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
    {
      "key": "advisor",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back"]
    }
  ]
}`)

/** The definition with one change applied by a function over its parsed JSON. */
function changed(
  from: FlowDefinition,
  edit: (doc: Record<string, unknown>) => void
): FlowDefinition {
  const doc = JSON.parse(JSON.stringify(from)) as Record<string, unknown>
  edit(doc)
  return parse(JSON.stringify(doc))
}

type Doc = {
  steps: Record<string, unknown>[] & { key: string; fields?: Record<string, unknown>[] }[]
}

const priyaFixesLabel = changed(base, (doc) => {
  const request = (doc as unknown as Doc).steps[0]
  if (request.fields !== undefined) request.fields[0].label = 'Summary'
})

const reasonField = {
  key: 'reason_category',
  label: 'Reason',
  control: 'select',
  options: ['graduation', 'prerequisite'],
  required: true,
}

const danaAddsField = changed(base, (doc) => {
  const request = (doc as unknown as Doc).steps[0]
  request.fields?.push(reasonField)
})

test('#264 S03 DF-3 two edits of different places merge, and each lands as its author made it', async () => {
  const { mergeDefinitions } = await merge()
  const merged = mergeDefinitions(base, priyaFixesLabel, danaAddsField)
  expect(merged.conflicts).toEqual([])
  const request = merged.definition?.steps[0]
  expect(request?.fields?.map((field) => field.key)).toEqual([
    'summary',
    'overload_credits',
    'reason_category',
  ])
  expect(request?.fields?.[0].label).toBe('Summary')
  expect(request?.fields?.[2]).toEqual(reasonField)
  // The merge is symmetric: the order of the two writes changes nothing but
  // the order of the additions.
  expect(mergeDefinitions(base, danaAddsField, priyaFixesLabel).definition).toEqual(
    merged.definition
  )
  // Steps each side added both land, ours first.
  const oursStep = changed(base, (doc) =>
    (doc as unknown as Doc).steps.push({ key: 'chair', targets: [{ group: 'CS-Chairs' }] })
  )
  const theirsStep = changed(base, (doc) =>
    (doc as unknown as Doc).steps.push({
      key: 'registrar',
      targets: [{ team: 'registrar-office' }],
    })
  )
  const both = mergeDefinitions(base, oursStep, theirsStep)
  expect(both.conflicts).toEqual([])
  expect(both.definition?.steps.map((step) => step.key)).toEqual([
    'request',
    'advisor',
    'chair',
    'registrar',
  ])
})

test('#264 S03 DF-3 the same place changed differently on both sides is a conflict that names its path', async () => {
  const { mergeDefinitions } = await merge()
  const danaRenames = changed(base, (doc) => {
    const request = (doc as unknown as Doc).steps[0]
    if (request.fields !== undefined) request.fields[0].label = 'Request summary'
  })
  const conflict = mergeDefinitions(base, priyaFixesLabel, danaRenames)
  expect(conflict.definition).toBeUndefined()
  expect(conflict.conflicts).toEqual([
    {
      path: '/steps/request/fields/summary/label',
      base: 'Sumary',
      ours: 'Summary',
      theirs: 'Request summary',
    },
  ])
  // A place one side removed and the other changed is a conflict too; a
  // place one side removed and the other left alone is removed.
  const removesField = changed(base, (doc) => {
    const request = (doc as unknown as Doc).steps[0]
    request.fields?.shift()
  })
  const removedAndChanged = mergeDefinitions(base, removesField, priyaFixesLabel)
  expect(removedAndChanged.definition).toBeUndefined()
  expect(removedAndChanged.conflicts.map((entry) => entry.path)).toEqual([
    '/steps/request/fields/summary',
  ])
  const removedAndLeft = mergeDefinitions(base, removesField, danaAddsField)
  expect(removedAndLeft.conflicts).toEqual([])
  expect(removedAndLeft.definition?.steps[0].fields?.map((field) => field.key)).toEqual([
    'overload_credits',
    'reason_category',
  ])
  // The same change on both sides is no conflict.
  expect(mergeDefinitions(base, priyaFixesLabel, priyaFixesLabel)).toEqual({
    definition: priyaFixesLabel,
    conflicts: [],
  })
})

test('#264 I4 the base of a write is read back from the log by its content hash', async () => {
  const { definitionByHash } = await merge()
  const deps = (id: string) => ({ clock: () => 1, ids: () => id })
  const pushed = push(createFlow('course-overload'), base, deps('push-1'), 'user:dana')
  const released = publish(pushed.flow, deps('publish-1'), 'user:dana')
  const edited = push(released.flow, priyaFixesLabel, deps('push-2'), 'user:priya')
  let state = emptyState
  for (const operation of [pushed.operation, released.operation, edited.operation]) {
    state = apply(operation, state)
  }
  expect(definitionByHash(state.log, 'course-overload', contentHash(base))).toEqual(base)
  expect(definitionByHash(state.log, 'course-overload', contentHash(priyaFixesLabel))).toEqual(
    priyaFixesLabel
  )
  expect(definitionByHash(state.log, 'other', contentHash(base))).toBeUndefined()
  expect(definitionByHash(state.log, 'course-overload', 'nothing')).toBeUndefined()
})
