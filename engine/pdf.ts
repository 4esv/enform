// Issue OU-1, FM-3, VT-2, VT-5, I4, I8, I12, I13, ADR 0009: render one
// instance as a PDF for one step.
//
// The renderer is a read of the instance, never a second decision. The caller
// gives it the `InstanceView` that the engine's rules decided (FM-3): the
// visible fields with their labels and controls, and only the values that the
// actor may read. A hidden field and a hidden value are absent from the input,
// so they cannot reach the page (I8). The step history comes from the tracker
// and the timeline projections of the log (I4, VT-2, VT-5), and a connector
// call shows its operation, time and outcome and never a response body (I13).
//
// The output is deterministic for the same input and clock (I6): the header
// date comes from `now`, the metadata date is the same instant, the history
// times come from the log, and PDFKit writes no random source into the file.
// The default Helvetica fonts cover ASCII only, so the renderer writes ASCII:
// a non-ASCII character becomes `?` and a skip condition is written with the
// operator as words (`<=` becomes "at most") instead of the `≤` glyph.

import PDFDocument from 'pdfkit'
import type { JsonValue } from './definition.js'
import type { InstanceView } from './instances.js'
import type { TimelineEntry } from './timeline.js'
import type { TrackerStep } from './tracker.js'

/** The input of one PDF render (OU-1): the read, its flow and the one clock. */
export type InstancePdfInput = {
  /** The slug of the flow that the instance runs (DF-2). */
  readonly flowSlug: string
  /** The title that the flow shows (I14); absent falls back to the slug. */
  readonly flowTitle?: string
  /** The id of the instance (DX-1). */
  readonly instanceId: string
  /** The principal that requested the PDF; the header names it. */
  readonly actor: string
  /** The step whose form the PDF shows: the current step or a named one (OU-1). */
  readonly step: string
  /** The injected clock (I6), in milliseconds since the epoch. */
  readonly now: number
  /** The form and the status as the engine read them for this actor and step (FM-3, I8). */
  readonly view: InstanceView
  /** The instance's own timeline entries, in log order (VT-5, I4). */
  readonly timeline: readonly TimelineEntry[]
}

/** The left and right margin of every page (points). */
const MARGIN = 50

/** The bottom margin that the footer uses (points). */
const FOOTER_MARGIN = 32

/** The body font size (points). */
const BODY_SIZE = 10

/** The heading font size (points). */
const HEADING_SIZE = 14

/** The title font size (points). */
const TITLE_SIZE = 20

/**
 * Render one instance as a PDF (OU-1). The function reads only its input: it
 * calls no engine decision and no I/O, and the same input and clock give the
 * same bytes (I6). The page has a header, the form as the step sees it, the
 * step history from the tracker and the timeline, and the enform footer.
 */
export function renderInstancePdf(input: InstancePdfInput): Buffer {
  const document = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: ascii(`${input.flowTitle ?? input.flowSlug} ${input.instanceId}`),
      Subject: ascii(`Instance ${input.instanceId}, step ${input.step}`),
      Author: ascii(input.actor),
      CreationDate: new Date(input.now),
      ModDate: new Date(input.now),
    },
  })

  writeHeader(document, input)
  writeForm(document, input)
  writeHistory(document, input)
  writeFooters(document)

  document.end()
  const chunks: Buffer[] = []
  let chunk = document.read() as Buffer | null
  while (chunk !== null) {
    chunks.push(chunk)
    chunk = document.read() as Buffer | null
  }
  return Buffer.concat(chunks)
}

/** The header: the flow, the instance, the step, the actor and the date (OU-1). */
function writeHeader(document: PDFKit.PDFDocument, input: InstancePdfInput): void {
  document
    .fontSize(TITLE_SIZE)
    .fillColor('#111111')
    .text(ascii(input.flowTitle ?? input.flowSlug))
  document.moveDown(0.25)
  document.fontSize(BODY_SIZE).fillColor('#333333')
  line(document, `Flow: ${input.flowSlug}`)
  line(document, `Instance: ${input.instanceId}`)
  line(document, `Step: ${input.step}`)
  line(document, `Actor: ${input.actor}`)
  line(document, `Date: ${dateText(input.now)}`)
  line(
    document,
    `Status: ${input.view.status.state} (step ${input.view.status.step} of ${input.view.status.totalSteps})`
  )
  document.moveDown(0.75)
}

/** The form as the requested step sees it (FM-3, I8). */
function writeForm(document: PDFKit.PDFDocument, input: InstancePdfInput): void {
  heading(document, 'Form')
  if (input.view.fields.length === 0) {
    document.fontSize(BODY_SIZE).fillColor('#333333').text('No fields are visible on this step.')
    document.moveDown(0.75)
    return
  }
  for (const field of input.view.fields) {
    const label = field.label ?? field.key
    document
      .fontSize(BODY_SIZE)
      .fillColor('#111111')
      .text(`Field: ${ascii(label)} (${field.key})`)
    document.fontSize(BODY_SIZE).fillColor('#333333')
    const required = input.view.required.includes(field.key) ? ' required' : ''
    const options =
      field.options === undefined || field.options.length === 0
        ? ''
        : ` options: ${field.options.map((option) => ascii(option)).join(', ')}`
    line(document, `  Control: ${field.control}${required}${options}`)
    line(document, `  Value: ${valueText(input.view.values[field.key])}`)
    document.moveDown(0.25)
  }
  document.moveDown(0.5)
}

/** The step history: the tracker states and the instance's timeline (VT-2, VT-5, I4). */
function writeHistory(document: PDFKit.PDFDocument, input: InstancePdfInput): void {
  heading(document, 'Step history')
  if (input.view.tracker.length === 0) {
    document.fontSize(BODY_SIZE).fillColor('#333333').text('No steps are recorded.')
    document.moveDown(0.5)
  }
  for (const step of input.view.tracker) writeTrackerStep(document, step)
  document.moveDown(0.5)

  heading(document, 'Timeline')
  if (input.timeline.length === 0) {
    document.fontSize(BODY_SIZE).fillColor('#333333').text('No events are recorded.')
    document.moveDown(0.5)
    return
  }
  for (const entry of input.timeline) writeTimelineEntry(document, entry)
}

/** One tracker step: its state, holder, start and last activity (VT-2, S14). */
function writeTrackerStep(document: PDFKit.PDFDocument, step: TrackerStep): void {
  document.fontSize(BODY_SIZE).fillColor('#111111').text(`${step.key}: ${step.state}`)
  document.fontSize(BODY_SIZE).fillColor('#333333')
  if (step.holder !== undefined) line(document, `  Holder: ${step.holder}`)
  if (step.startAt !== undefined) line(document, `  Start: ${timestampText(step.startAt)}`)
  if (step.lastActivityAt !== undefined) {
    line(document, `  Last activity: ${timestampText(step.lastActivityAt)}`)
  }
  if (step.dueAt !== undefined) line(document, `  Due: ${timestampText(step.dueAt)}`)
  if (step.condition !== undefined) {
    line(document, `  Skipped when: ${conditionText(step.condition)}`)
  }
  if (step.comment !== undefined) line(document, `  Comment: ${ascii(step.comment)}`)
  document.moveDown(0.15)
}

/** One timeline entry: the type, actor, time, step and comment, and a call's outcome (I13). */
function writeTimelineEntry(document: PDFKit.PDFDocument, entry: TimelineEntry): void {
  const who = entry.actor === undefined ? '' : ` actor=${entry.actor}`
  const step = entry.step === undefined ? '' : ` step=${entry.step}`
  document
    .fontSize(BODY_SIZE)
    .fillColor('#111111')
    .text(`${timestampText(entry.at)} ${entry.type}${who}${step}`)
  document.fontSize(BODY_SIZE).fillColor('#333333')
  if (entry.comment !== undefined) line(document, `  Comment: ${ascii(entry.comment)}`)
  if (entry.call !== undefined) {
    line(
      document,
      `  Call: ${entry.call.operation} ${entry.call.outcome} at ${timestampText(entry.call.time)}`
    )
  }
  document.moveDown(0.1)
}

/** The enform footer on every buffered page. */
function writeFooters(document: PDFKit.PDFDocument): void {
  const range = document.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index)
    const footer = `enform - page ${index + 1} of ${range.count}`
    // The footer sits inside the bottom margin. PDFKit starts a new page when
    // text passes the page's max Y, so the margin is removed for this line.
    const bottom = document.page.margins.bottom
    document.page.margins.bottom = 0
    document
      .fontSize(8)
      .fillColor('#666666')
      .text(ascii(footer), MARGIN, document.page.height - FOOTER_MARGIN, {
        width: document.page.width - MARGIN * 2,
        align: 'center',
        lineBreak: false,
      })
    document.page.margins.bottom = bottom
  }
}

/** One section heading. */
function heading(document: PDFKit.PDFDocument, text: string): void {
  document.fontSize(HEADING_SIZE).fillColor('#111111').text(text)
  document.moveDown(0.35)
}

/** One plain body line. */
function line(document: PDFKit.PDFDocument, text: string): void {
  document.fontSize(BODY_SIZE).fillColor('#333333').text(ascii(text))
}

/** The printable form of one JSON value (FM-7). */
function valueText(value: JsonValue | undefined): string {
  if (value === undefined) return 'not filled'
  if (value === null) return 'null'
  if (typeof value === 'string') return ascii(value === '' ? '(empty)' : value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((entry) => valueText(entry)).join(', ')
  return ascii(JSON.stringify(value))
}

/** One day, from the injected clock (I6). */
function dateText(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** One instant, from the log or the injected clock (I4, I6). */
function timestampText(at: number): string {
  return new Date(at).toISOString()
}

/**
 * A skip condition in words (OU-1). The PDF uses the default Helvetica fonts,
 * which do not cover `≤`, so the JSON Logic operator is written as a word. A
 * condition that is not an object renders as its JSON text, then loses any
 * non-ASCII character.
 */
function conditionText(condition: JsonValue): string {
  return ascii(conditionWords(condition))
}

/** The readable form of a JSON Logic value, with each operator as a word. */
function conditionWords(value: JsonValue): string {
  if (Array.isArray(value)) return value.map((entry) => conditionWords(entry)).join(', ')
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 1) {
      const [operator, right] = entries[0] as [string, JsonValue]
      const word = OPERATOR_WORDS[operator]
      if (word !== undefined) {
        if (Array.isArray(right) && right.length === 2) {
          return `${word} (${conditionWords(right[0] as JsonValue)}, ${conditionWords(right[1] as JsonValue)})`
        }
        return `${word} ${conditionWords(right)}`
      }
      if (operator === 'var' && typeof right === 'string') return right
    }
    return JSON.stringify(value)
  }
  return String(value)
}

/** The operators that the safe skip-condition text names in words (FM-5, OU-1). */
const OPERATOR_WORDS: Readonly<Record<string, string>> = {
  '<=': 'at most',
  '<': 'less than',
  '>=': 'at least',
  '>': 'more than',
  '==': 'equals',
  '!=': 'not equal',
  and: 'all of',
  or: 'any of',
  not: 'not',
  in: 'in',
}

/**
 * Keep the text inside the ASCII range that the default PDF fonts cover
 * (OU-1). A composed accent loses its mark; any other non-ASCII character
 * becomes `?`, so the text extractor reads a stable string.
 */
function ascii(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\t\n\r\x20-\x7e]/g, '?')
}
