// Issue #106, #181, FM-1, FM-3, FM-7, A9: the form model. It narrows a v2 flow
// definition as it arrives from readFlow and answers what a step's form looks
// like. It is a pure presentation view: it reads no clock, no random source
// and no I/O, and it decides no validation, authorization or routing. The
// engine stays authoritative (A9): visible and editable here are presentation
// only, and the server re-validates every submission (FM-3, FM-4).

/** One of the sixteen FM-1 controls (FM-1). */
export type Control =
  | 'text'
  | 'long-text'
  | 'number'
  | 'money'
  | 'date'
  | 'select'
  | 'multi-select'
  | 'checkbox'
  | 'radio'
  | 'yes-no'
  | 'email'
  | 'phone'
  | 'file'
  | 'user'
  | 'static'
  | 'repeating'

/** What the DOM renders for a control (FM-1, ADR 0009). */
export type InputKind =
  | 'single-line'
  | 'textarea'
  | 'number'
  | 'date'
  | 'email'
  | 'tel'
  | 'select'
  | 'checkboxes'
  | 'radios'
  | 'switch'
  | 'file'
  | 'person'
  | 'static'
  | 'repeating'

/** One JSON value (DF-1, FM-7). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** One field as the form renders it (FM-1, FM-3, FM-7). */
export interface FormField {
  readonly key: string
  readonly control: Control
  /** The human label when the definition carries one; absent otherwise. */
  readonly label?: string
  readonly options: readonly string[]
  readonly required: boolean
  readonly editable: boolean
  /** The current value from the values the form holds; absent when none. */
  readonly value?: JsonValue
}

/** One named group of fields (FM-1). */
export interface FormSection {
  readonly key: string
  readonly fields: readonly FormField[]
}

/** The form that a step shows: sections or flat fields, never both (FM-1). */
export interface StepForm {
  readonly stepKey: string
  readonly fields: readonly FormField[]
  readonly sections: readonly FormSection[]
}

/** The only definition version this interface reads (MVP.md 9.3). */
export const FORM_SCHEMA_VERSION = 2

const CONTROLS: ReadonlySet<string> = new Set([
  'text',
  'long-text',
  'number',
  'money',
  'date',
  'select',
  'multi-select',
  'checkbox',
  'radio',
  'yes-no',
  'email',
  'phone',
  'file',
  'user',
  'static',
  'repeating',
])

/**
 * The DOM kind of each of the sixteen controls (FM-1). Text is a single-line
 * input. A date, an email and a phone number are their own input types. A
 * number or an amount of money is an `<input type="number">`. A select is a
 * single `<select>`; multi-select, radio and yes-no render one element per
 * option, and yes-no's options are the strings 'yes' and 'no'. Checkbox
 * renders one boolean switch. File, user, static and repeating render their
 * own element or group.
 */
const CONTROL_KINDS: Record<Control, InputKind> = {
  text: 'single-line',
  'long-text': 'textarea',
  number: 'number',
  money: 'number',
  date: 'date',
  select: 'select',
  'multi-select': 'checkboxes',
  checkbox: 'switch',
  radio: 'radios',
  'yes-no': 'radios',
  email: 'email',
  phone: 'tel',
  file: 'file',
  user: 'person',
  static: 'static',
  repeating: 'repeating',
}

/** The controls that render as one plain input element (FM-1). */
const SINGLE_INPUTS: ReadonlySet<Control> = new Set([
  'text',
  'number',
  'money',
  'date',
  'email',
  'phone',
])

type Field = {
  readonly key: string
  readonly control: Control
  readonly label?: string
  readonly options?: readonly string[]
  readonly required?: boolean
}

type Section = {
  readonly key: string
  readonly fields: readonly Field[]
}

type Step = {
  readonly key: string
  readonly fields?: readonly Field[]
  readonly sections?: readonly Section[]
  readonly visible?: readonly string[]
  readonly editable?: readonly string[]
}

/** The step keys of a definition, in definition order. */
export function stepKeys(definition: Record<string, unknown>): readonly string[] {
  return readDefinition(definition).map((step) => step.key)
}

/**
 * The form that the named step shows (FM-1, FM-3, FM-7). A step shows either
 * flat fields or sections, never both. `visible` names the fields the step
 * shows and is absent when every field shows; `editable` names the fields the
 * actor may edit and is absent when no field is editable. The current value of
 * each field comes from `values`, and is absent when the values hold no entry
 * for the key.
 */
export function formModel(
  definition: Record<string, unknown>,
  stepKey: string,
  values: Readonly<Record<string, JsonValue>> = {}
): StepForm {
  const step = readDefinition(definition).find((candidate) => candidate.key === stepKey)
  if (step === undefined) throw new Error(`flow form model: the flow has no step ${stepKey}`)

  const visible = step.visible
  const editable = step.editable
  const shows = (key: string) => visible === undefined || visible.includes(key)
  const mayEdit = (key: string) => editable?.includes(key) ?? false

  const toField = (field: Field): FormField => {
    const hasValue = Object.hasOwn(values, field.key)
    return {
      key: field.key,
      control: field.control,
      ...(field.label === undefined ? {} : { label: field.label }),
      options: field.options ?? [],
      required: field.required ?? false,
      editable: mayEdit(field.key),
      ...(hasValue ? { value: values[field.key] } : {}),
    }
  }

  if (step.sections !== undefined) {
    const sections = step.sections.map((section) => ({
      key: section.key,
      fields: section.fields.filter((field) => shows(field.key)).map(toField),
    }))
    return { stepKey: step.key, fields: [], sections }
  }

  const fields = (step.fields ?? []).filter((field) => shows(field.key)).map(toField)
  return { stepKey: step.key, fields, sections: [] }
}

/** The DOM kind of a control (FM-1). */
export function controlKind(control: Control): InputKind {
  return CONTROL_KINDS[control]
}

/** Whether a control renders as one plain input element (FM-1). */
export function isSingleInput(control: Control): boolean {
  return SINGLE_INPUTS.has(control)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the v2 steps of a definition, and refuse any other version (9.3). */
function readDefinition(definition: Record<string, unknown>): readonly Step[] {
  if (!isRecord(definition)) throw new Error('flow form model: the definition is not an object')
  const version = definition.schemaVersion
  if (version !== FORM_SCHEMA_VERSION) {
    throw new Error(
      `flow form model: schemaVersion ${String(version)} is not readable (reads ${FORM_SCHEMA_VERSION})`
    )
  }
  if (!Array.isArray(definition.steps)) throw new Error('flow form model: steps must be an array')
  return definition.steps.map(readStep)
}

function readStep(body: unknown): Step {
  if (!isRecord(body)) throw new Error('flow form model: a step is not an object')
  if (typeof body.key !== 'string') throw new Error('flow form model: a step has no key')
  const fields = readFields(body.fields)
  const sections = readSections(body.sections)
  if (fields !== undefined && sections !== undefined) {
    throw new Error('flow form model: a step cannot have both fields and sections (FM-1)')
  }
  const visible = readKeys(body.visible, 'visible')
  const editable = readKeys(body.editable, 'editable')
  return {
    key: body.key,
    ...(fields === undefined ? {} : { fields }),
    ...(sections === undefined ? {} : { sections }),
    ...(visible === undefined ? {} : { visible }),
    ...(editable === undefined ? {} : { editable }),
  }
}

function readFields(value: unknown): readonly Field[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('flow form model: fields must be an array')
  return value.map(readField)
}

function readSections(value: unknown): readonly Section[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('flow form model: sections must be an array')
  return value.map(readSection)
}

function readSection(body: unknown): Section {
  if (!isRecord(body)) throw new Error('flow form model: a section is not an object')
  if (typeof body.key !== 'string') throw new Error('flow form model: a section has no key')
  if (!Array.isArray(body.fields)) {
    throw new Error('flow form model: section fields must be an array')
  }
  return { key: body.key, fields: body.fields.map(readField) }
}

function readField(body: unknown): Field {
  if (!isRecord(body)) throw new Error('flow form model: a field is not an object')
  if (typeof body.key !== 'string') throw new Error('flow form model: a field has no key')
  const label = typeof body.label === 'string' ? body.label : undefined
  const options = readOptions(body.options)
  const required = readRequired(body.required)
  return {
    key: body.key,
    control: readControl(body.control),
    ...(label === undefined ? {} : { label }),
    ...(options === undefined ? {} : { options }),
    ...(required === undefined ? {} : { required }),
  }
}

function readRequired(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error('flow form model: required must be a boolean (FM-1)')
  }
  return value
}

function readControl(value: unknown): Control {
  if (typeof value === 'string' && CONTROLS.has(value)) return value as Control
  throw new Error(`flow form model: ${String(value)} is not a control (FM-1)`)
}

function readOptions(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('flow form model: options must be an array')
  return value.map((option) => {
    if (typeof option !== 'string') {
      throw new Error('flow form model: an option must be a string (FM-1)')
    }
    return option
  })
}

function readKeys(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`flow form model: ${name} must be an array`)
  return value.map((key) => {
    if (typeof key !== 'string') throw new Error(`flow form model: a ${name} key must be a string`)
    return key
  })
}
