// Issue #264, S03, S04, DF-6, I12, I14, ADR 0009: the diff view of the
// builder. It shows the field-level difference between two points of the
// flow's history, two published versions or a version and the draft, with
// the author of each change (DF-6, S03). The server computes the difference
// from the log (I4, I14); the view lists the points, asks for one pair and
// renders each change in plain language. Every element is plain DOM (ADR
// 0009), and the view reaches the API through the generated client only
// (I12).

import { type AttributedChange, readFlow, readFlowDiff } from '../client/client.js'

/** The points of a flow's history, newest first: the draft, then every published version. */
export function pointsOf(newestVersion: number | undefined): readonly string[] {
  const points = ['draft']
  for (let version = newestVersion ?? 0; version >= 1; version -= 1) points.push(String(version))
  return points
}

/** A point in plain language. */
export function pointLabel(point: string): string {
  return point === 'draft' ? 'Draft' : `Version ${point}`
}

/** One change in plain language: where, what, from what to what, its class and its author. */
export function describeChange(change: AttributedChange): string {
  const values =
    change.before !== undefined || change.after !== undefined
      ? `, from ${JSON.stringify(change.before)} to ${JSON.stringify(change.after)}`
      : ''
  const author = change.actor === undefined ? '' : ` by ${change.actor}`
  return `${change.path}: ${change.message}${values} (${change.class})${author}`
}

export interface DiffOptions {
  /** The element that receives the view. */
  readonly root: HTMLElement
  readonly slug: string
}

/** Mount the diff view for one flow below the builder (DF-6). */
export async function mountDiff(options: DiffOptions): Promise<void> {
  const panel = document.createElement('section')
  panel.className = 'diff'
  panel.dataset.diff = ''
  const heading = document.createElement('h2')
  heading.textContent = 'Changes between versions'
  panel.appendChild(heading)
  options.root.appendChild(panel)

  let newest: number | undefined
  try {
    newest = (await readFlow(options.slug)).version
  } catch {
    // An unpublished flow has only its draft.
  }
  const points = pointsOf(newest)

  const form = document.createElement('form')
  form.className = 'diff-points'
  const fromLabel = document.createElement('label')
  fromLabel.textContent = 'From '
  const from = document.createElement('select')
  from.name = 'from'
  from.dataset.diffFrom = ''
  const parent = document.createElement('option')
  parent.value = ''
  parent.textContent = 'the version before'
  from.appendChild(parent)
  for (const point of points) from.appendChild(optionOf(point))
  fromLabel.appendChild(from)
  const toLabel = document.createElement('label')
  toLabel.textContent = ' To '
  const to = document.createElement('select')
  to.name = 'to'
  to.dataset.diffTo = ''
  for (const point of points) to.appendChild(optionOf(point))
  toLabel.appendChild(to)
  const show = document.createElement('button')
  show.type = 'submit'
  show.textContent = 'Show changes'
  show.dataset.diffShow = ''
  const status = document.createElement('p')
  status.className = 'status'
  status.dataset.diffStatus = ''
  const list = document.createElement('ol')
  list.dataset.diffList = ''
  form.append(fromLabel, toLabel, ' ', show)
  panel.append(form, status, list)

  const load = async (): Promise<void> => {
    status.textContent = ''
    list.replaceChildren()
    try {
      const diff = await readFlowDiff(
        options.slug,
        from.value === '' ? undefined : from.value,
        to.value
      )
      status.textContent =
        diff.changes.length === 0
          ? `No change from ${pointLabel(diff.from)} to ${pointLabel(diff.to)}.`
          : `${diff.changes.length} ${diff.changes.length === 1 ? 'change' : 'changes'} from ${pointLabel(diff.from)} to ${pointLabel(diff.to)}.`
      for (const change of diff.changes) {
        const item = document.createElement('li')
        item.dataset.diffChange = ''
        item.dataset.diffPath = change.path
        item.dataset.diffClass = change.class
        if (change.actor !== undefined) item.dataset.diffActor = change.actor
        item.textContent = describeChange(change)
        list.appendChild(item)
      }
    } catch (error: unknown) {
      status.textContent = error instanceof Error ? error.message : String(error)
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void load()
  })
  await load()
}

function optionOf(point: string): HTMLOptionElement {
  const option = document.createElement('option')
  option.value = point
  option.textContent = pointLabel(point)
  return option
}
