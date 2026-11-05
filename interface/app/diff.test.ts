import { expect, test } from 'vitest'

// Issue #264, S03, S04, DF-6: the diff view of the builder. It lists the
// points of a flow's history (the draft and every published version), and
// renders each change the server attributes in plain language: where it
// sits, what changed from what to what, its class and who made it. The
// functions are pure, so the checks run in Node; the integration suite
// drives the view in Chromium.

type Change = {
  class: string
  message: string
  path: string
  before?: unknown
  after?: unknown
  actor?: string
  at?: number
}

type Diff = {
  pointsOf: (newestVersion: number | undefined) => readonly string[]
  pointLabel: (point: string) => string
  describeChange: (change: Change) => string
}

const DIFF_MODULE = new URL('./diff.js', import.meta.url).href

async function diff(): Promise<Diff> {
  return (await import(DIFF_MODULE)) as unknown as Diff
}

test('#264 DF-6 the view lists the draft and every published version, newest first', async () => {
  const { pointsOf, pointLabel } = await diff()
  expect(pointsOf(3)).toEqual(['draft', '3', '2', '1'])
  expect(pointsOf(undefined)).toEqual(['draft'])
  expect(pointLabel('draft')).toBe('Draft')
  expect(pointLabel('2')).toBe('Version 2')
})

test('#264 S03 S04 a change reads as where, what, its class and its author', async () => {
  const { describeChange } = await diff()
  expect(
    describeChange({
      class: 'edit',
      message: 'the label of field summary changed',
      path: '/steps/request/fields/summary/label',
      before: 'Sumary',
      after: 'Summary',
      actor: 'user:priya',
      at: 3,
    })
  ).toBe(
    '/steps/request/fields/summary/label: the label of field summary changed, from "Sumary" to "Summary" (edit) by user:priya'
  )
  expect(
    describeChange({
      class: 'structural',
      message: 'a field was added: reason_category',
      path: '/steps/request/fields/reason_category',
      actor: 'user:dana',
    })
  ).toBe(
    '/steps/request/fields/reason_category: a field was added: reason_category (structural) by user:dana'
  )
  expect(
    describeChange({
      class: 'structural',
      message: 'a step was added: request',
      path: '/steps/request',
    })
  ).toBe('/steps/request: a step was added: request (structural)')
})
