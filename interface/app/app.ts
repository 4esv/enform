// Issue #106, #181, #184, #187, FM-1, FM-3, FM-7, DX-1, DX-4, I12, A9, ADR 0010: the
// app shell, the first browser surface. It loads the published flow through
// the generated client, builds the form that the model describes, reads the
// values back, and posts an intent: the flow, the instance id it minted and
// the values it collected. The shell decides nothing: it runs no validation,
// no authorization and no routing (A9). The server resolves the start through
// the engine, so the shell names no `currentStep` and no `assignees`. The
// shell reaches the API only through the generated client, so it never names
// an API path by hand (I12).
//
// The clock and the ID sources enter at one place, the mount options, so a
// caller can inject them. The defaults are Date.now and crypto.randomUUID, and
// the instance id has a source of its own, because it is not the operation id
// (DX-1, #187). This mirrors the engine's injected sources (I6); gui mode will
// inject its own.

import { appendOperation, type Operation, readFlow, setClient } from '../client/client.js'
import { controlKind, type FormField, formModel, type JsonValue, stepKeys } from './form.js'

/** The versioned event type of a start (S06, MVP.md 9.1). */
const INSTANCE_STARTED = 'instance.started@1'

export interface AppOptions {
  /** The element that receives the form. */
  readonly root: HTMLElement
  readonly baseUrl: string
  readonly token: string
  readonly slug: string
  /** The signed-in principal that starts the submission (ID-2, ID-4). */
  readonly actor: string
  /** The injected clock (I6); absent means Date.now. */
  readonly clock?: () => number
  /** The injected operation ID source (I1, I6); absent means crypto.randomUUID. */
  readonly ids?: () => string
  /** The injected instance ID source (DX-1, #187, I6); absent means crypto.randomUUID. */
  readonly instanceIds?: () => string
}

/** Load the flow, render its first step and wire the submit (FM-1, A9). */
export async function mountApp(options: AppOptions): Promise<void> {
  const clock = options.clock ?? (() => Date.now())
  const ids = options.ids ?? (() => crypto.randomUUID())
  const instanceIds = options.instanceIds ?? (() => crypto.randomUUID())
  const readers = new Map<string, () => JsonValue | undefined>()

  const readValues = (): Record<string, JsonValue> => {
    const values: Record<string, JsonValue> = {}
    for (const [key, read] of readers) {
      const value = read()
      if (value !== undefined) values[key] = value
    }
    return values
  }

  const renderField = (field: FormField): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'field'
    const label = document.createElement('label')
    label.textContent = field.label ?? field.key
    row.appendChild(label)
    row.appendChild(renderControl(field, readers))
    return row
  }

  const renderFields = (host: HTMLElement, fields: readonly FormField[]): void => {
    for (const field of fields) host.appendChild(renderField(field))
  }

  try {
    setClient({ baseUrl: options.baseUrl, token: options.token })
    const flow = await readFlow(options.slug)
    const stepKey = stepKeys(flow.definition)[0]
    if (stepKey === undefined) throw new Error('the flow has no step to show')
    const model = formModel(flow.definition, stepKey)

    const root = options.root
    root.replaceChildren()
    const heading = document.createElement('h1')
    heading.textContent = flow.slug
    root.appendChild(heading)

    const form = document.createElement('form')
    for (const section of model.sections) {
      const group = document.createElement('section')
      const title = document.createElement('h2')
      title.textContent = section.key
      group.appendChild(title)
      renderFields(group, section.fields)
      form.appendChild(group)
    }
    renderFields(form, model.fields)

    const status = document.createElement('p')
    status.className = 'status'
    const submit = document.createElement('button')
    submit.type = 'button'
    submit.textContent = 'Submit'
    submit.addEventListener('click', () => {
      const intent: Operation = {
        id: ids(),
        type: INSTANCE_STARTED,
        at: clock(),
        actor: options.actor,
        payload: {
          flow: options.slug,
          instanceId: instanceIds(),
          values: readValues(),
        },
      }
      void appendOperation(intent)
        .then(() => {
          status.textContent = 'Synced'
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : String(error)
        })
    })
    form.appendChild(submit)
    form.appendChild(status)
    root.appendChild(form)
  } catch (error: unknown) {
    options.root.textContent = error instanceof Error ? error.message : String(error)
  }
}

function renderControl(
  field: FormField,
  readers: Map<string, () => JsonValue | undefined>
): HTMLElement {
  const kind = controlKind(field.control)
  switch (kind) {
    case 'single-line': {
      const input = document.createElement('input')
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      readers.set(field.key, () => input.value)
      return input
    }
    case 'date': {
      const input = document.createElement('input')
      input.type = 'date'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      // An empty date omits its key: the engine's validator never accepts ''.
      readers.set(field.key, () => (input.value === '' ? undefined : input.value))
      return input
    }
    case 'email': {
      const input = document.createElement('input')
      input.type = 'email'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      readers.set(field.key, () => input.value)
      return input
    }
    case 'tel': {
      const input = document.createElement('input')
      input.type = 'tel'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      readers.set(field.key, () => input.value)
      return input
    }
    case 'textarea': {
      const textarea = document.createElement('textarea')
      textarea.name = field.key
      textarea.disabled = !field.editable
      if (typeof field.value === 'string') textarea.value = field.value
      readers.set(field.key, () => textarea.value)
      return textarea
    }
    case 'number': {
      const input = document.createElement('input')
      input.type = 'number'
      if (field.control === 'money') input.step = '0.01'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'number') input.value = String(field.value)
      // An empty number omits its key: Number('') is 0, which is a value the
      // user did not enter.
      readers.set(field.key, () => (input.value === '' ? undefined : Number(input.value)))
      return input
    }
    case 'select': {
      const select = document.createElement('select')
      select.name = field.key
      select.disabled = !field.editable
      for (const option of field.options) {
        const element = document.createElement('option')
        element.value = option
        element.textContent = option
        select.appendChild(element)
      }
      if (typeof field.value === 'string') select.value = field.value
      readers.set(field.key, () => (select.value === '' ? undefined : select.value))
      return select
    }
    case 'checkboxes': {
      const group = document.createElement('div')
      const boxes: HTMLInputElement[] = []
      for (const option of field.options) {
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.name = field.key
        box.value = option
        box.disabled = !field.editable
        if (Array.isArray(field.value) && field.value.includes(option)) box.checked = true
        const optionLabel = document.createElement('label')
        optionLabel.appendChild(box)
        optionLabel.appendChild(document.createTextNode(option))
        group.appendChild(optionLabel)
        boxes.push(box)
      }
      readers.set(field.key, () => boxes.filter((box) => box.checked).map((box) => box.value))
      return group
    }
    case 'radios': {
      const group = document.createElement('div')
      const radios: HTMLInputElement[] = []
      // The engine accepts only 'yes' and 'no' for a yes-no control, so it
      // renders as two radios with those values (FM-1).
      const options = field.control === 'yes-no' ? ['yes', 'no'] : field.options
      for (const option of options) {
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = field.key
        radio.value = option
        radio.disabled = !field.editable
        if (field.value === option) radio.checked = true
        const optionLabel = document.createElement('label')
        optionLabel.appendChild(radio)
        optionLabel.appendChild(document.createTextNode(option))
        group.appendChild(optionLabel)
        radios.push(radio)
      }
      readers.set(field.key, () => radios.find((radio) => radio.checked)?.value ?? null)
      return group
    }
    case 'switch': {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.name = field.key
      input.disabled = !field.editable
      input.checked = field.value === true
      readers.set(field.key, () => input.checked)
      return input
    }
    case 'file': {
      const input = document.createElement('input')
      input.type = 'file'
      input.name = field.key
      input.disabled = !field.editable
      // No chosen file omits its key; a chosen file contributes its name.
      readers.set(field.key, () => input.files?.[0]?.name)
      return input
    }
    case 'person': {
      const input = document.createElement('input')
      input.type = 'text'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      // ID-4: a person is an immutable principal. The public API has no
      // directory read yet, so the form takes the principal as text and does
      // not invent a lookup.
      readers.set(field.key, () => input.value)
      return input
    }
    case 'static': {
      const text = document.createElement('div')
      text.className = 'static'
      text.dataset.field = field.key
      text.textContent = field.value === undefined ? '' : String(field.value)
      return text
    }
    case 'repeating': {
      const fieldset = document.createElement('fieldset')
      fieldset.className = 'repeating'
      fieldset.dataset.field = field.key
      const rows: HTMLTextAreaElement[] = []
      const list = document.createElement('div')
      const add = document.createElement('input')
      add.type = 'button'
      add.value = 'Add row'
      add.dataset.addRow = field.key
      const addRow = (text: string): void => {
        const row = document.createElement('div')
        const textarea = document.createElement('textarea')
        textarea.name = field.key
        textarea.disabled = !field.editable
        textarea.value = text
        rows.push(textarea)
        const remove = document.createElement('input')
        remove.type = 'button'
        remove.value = 'Remove'
        remove.dataset.removeRow = field.key
        remove.addEventListener('click', () => {
          const index = rows.indexOf(textarea)
          if (index >= 0) rows.splice(index, 1)
          row.remove()
        })
        row.appendChild(textarea)
        row.appendChild(remove)
        list.appendChild(row)
      }
      add.addEventListener('click', () => addRow(''))
      fieldset.appendChild(list)
      fieldset.appendChild(add)
      if (Array.isArray(field.value)) {
        for (const record of field.value) addRow(JSON.stringify(record))
      }
      readers.set(field.key, () => {
        const records: JsonValue[] = []
        for (const row of rows) {
          const text = row.value.trim()
          if (text === '') continue
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            records.push(text)
            continue
          }
          // A row that is not a JSON object contributes its raw text, so the
          // server refuses it by field path (FM-4); the shell decides nothing.
          records.push(isJsonObject(parsed) ? parsed : text)
        }
        return records.length === 0 ? undefined : records
      })
      return fieldset
    }
  }
}

/** A JSON object: not null and not an array. */
function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
