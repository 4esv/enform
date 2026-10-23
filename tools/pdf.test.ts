import { join } from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, test } from 'vitest'
import type { InstanceView } from '../engine/instances.js'
import { renderInstancePdf } from '../engine/pdf.js'
import type { TimelineEntry } from '../engine/timeline.js'

// Issue OU-1, FM-3, VT-2, VT-5, I4, I8, I13: the PDF renderer is a read of the
// `InstanceView` that the engine decided. These checks run without the stack:
// the visible field and its value reach the page, a hidden field and a hidden
// value do not, a connector call shows its operation, outcome and time and no
// response body, the skip condition is ASCII, and the same input and clock give
// the same bytes.

const STANDARD_FONTS = join(
  import.meta.dirname,
  '..',
  'node_modules',
  'pdfjs-dist',
  'standard_fonts'
)

/** The form as one step sees it: one visible field and one hidden value. */
function view(): InstanceView {
  return {
    instanceId: 'instance-1',
    status: {
      step: 2,
      totalSteps: 3,
      currentStep: 'request',
      holder: 'user-1',
      state: 'in-progress',
      skipped: [],
    },
    tracker: [
      {
        key: 'chair',
        state: 'skipped',
        condition: { '<=': [{ var: 'credits' }, 2] },
      },
      {
        key: 'request',
        state: 'opened',
        holder: 'user-1',
        startAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_001_000,
      },
    ],
    visible: ['summary'],
    editable: [],
    required: ['summary'],
    collapsed: [],
    values: { summary: 'Three extra credits', secret: 'Hidden value' },
    fields: [{ key: 'summary', control: 'text', label: 'Summary' }],
    outcomes: [],
    version: 5,
    previousSteps: [],
    notes: [],
    canWithdraw: false,
    canCancel: false,
    canTakeOver: false,
  }
}

/** The timeline of the instance, with one connector call (I13). */
const timeline: readonly TimelineEntry[] = [
  { seq: 1, at: 1_700_000_000_000, actor: 'user-1', type: 'instance.started@1' },
  {
    seq: 2,
    at: 1_700_000_001_000,
    actor: 'user-1',
    type: 'connector.called@1',
    call: { operation: 'lookup', time: 1_700_000_001_000, outcome: 'ok' },
  },
]

/** The text of one rendered PDF. */
async function textOf(pdf: Buffer): Promise<string> {
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: `${STANDARD_FONTS}/`,
  }).promise
  const pages: string[] = []
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  return pages.join('\n')
}

test('#OU-1 the PDF renders the visible form and history, not a hidden field or value', async () => {
  const pdf = renderInstancePdf({
    flowSlug: 'demo',
    flowTitle: 'Course Overload',
    instanceId: 'instance-1',
    actor: 'reader-1',
    step: 'request',
    now: 1_700_000_009_000,
    view: view(),
    timeline,
  })

  expect(pdf.subarray(0, 5).toString(), 'the buffer starts with the PDF header').toBe('%PDF-')
  const text = await textOf(pdf)
  expect(text).toContain('Course Overload')
  expect(text).toContain('Instance: instance-1')
  expect(text).toContain('Step: request')
  expect(text).toContain('Actor: reader-1')
  expect(text).toContain('Field: Summary (summary)')
  expect(text).toContain('Value: Three extra credits')
  expect(text).not.toContain('Hidden value')
  expect(text).toContain('Skipped when: at most (credits, 2)')
  expect(text).not.toContain('≤')
  expect(text).toContain('instance.started@1')
  expect(text, 'the connector call shows operation, outcome and time').toContain(
    'Call: lookup ok at 2023-11-14T22:13:21.000Z'
  )
  expect(text).not.toContain('body')
  expect(text).toContain('enform - page 1 of 1')
})

test('#OU-1 the same input and clock give the same PDF bytes', () => {
  const input = {
    flowSlug: 'demo',
    flowTitle: 'Course Overload',
    instanceId: 'instance-1',
    actor: 'reader-1',
    step: 'request',
    now: 1_700_000_009_000,
    view: view(),
    timeline,
  }
  expect(renderInstancePdf(input).equals(renderInstancePdf(input))).toBe(true)
})
