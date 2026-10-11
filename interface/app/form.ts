// Issue #181, FM-1, FM-3, FM-7, A9: the form model. It narrows a v2 flow
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

/** The step keys of a definition, in definition order. */
export function stepKeys(definition: Record<string, unknown>): readonly string[] {
  return []
}

/** The form that the named step shows (FM-1, FM-3, FM-7). */
export function formModel(
  _definition: Record<string, unknown>,
  stepKey: string,
  _values?: Readonly<Record<string, JsonValue>>
): StepForm {
  return { stepKey, fields: [], sections: [] }
}

/** The DOM kind of a control (FM-1). */
export function controlKind(_control: Control): InputKind {
  return 'single-line'
}

/** Whether a control renders as one plain input element (FM-1). */
export function isSingleInput(_control: Control): boolean {
  return true
}
