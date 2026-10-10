// Issue #74, FM-1, FM-4, I6, A3: the form controls and their validation.
//
// FM-1: a form field is one of sixteen controls, from free text to a repeating
// section. FM-4: the server runs all rules and validation again at each
// submission and does not trust client state, so the check lives in the engine.
// validateField is pure and deterministic (I6): it reads only its two
// arguments, never the clock or a random source. The value of a choice control
// comes from the field's option list.

import type { ControlType, Field } from './definition.js'

/** One validation failure: the path of the field and the reason (FM-1, FM-4). */
export type FieldError = {
  /** The path of the field that failed, so a submission can name it (FM-1). */
  readonly path: string
  /** A short reason, for the message that the submission shows. */
  readonly message: string
}

/**
 * Validate one submitted value against one field (FM-1, FM-4). It returns the
 * failure that names the field path, or `undefined` when the value fits the
 * control. The function is pure and deterministic (I6).
 */
export function validateField(field: Field, value: unknown): FieldError | undefined {
  const message = check(field.control, field.options, value)
  return message === undefined ? undefined : { path: field.key, message }
}

/** The date form that a `date` control accepts (FM-1): ISO 8601, day precision. */
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The email form that an `email` control accepts (FM-1). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The phone form that a `phone` control accepts (FM-1): an optional plus, digits and separators. */
const PHONE = /^\+?[0-9][0-9 ()-]*$/

/** The reason a value does not fit a control, or `undefined` when it does (FM-1). */
function check(
  control: ControlType,
  options: readonly string[] | undefined,
  value: unknown
): string | undefined {
  switch (control) {
    case 'text':
    case 'long-text':
      return typeof value === 'string' ? undefined : 'must be text'
    case 'number':
    case 'money':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a number'
    case 'date':
      return typeof value === 'string' && DATE.test(value)
        ? undefined
        : 'must be a date (YYYY-MM-DD)'
    case 'select':
    case 'radio':
      return isOption(options, value) ? undefined : 'must be one of the field options'
    case 'multi-select':
      return isOptionList(options, value) ? undefined : 'must be a list of the field options'
    case 'checkbox':
      return typeof value === 'boolean' ? undefined : 'must be true or false'
    case 'yes-no':
      return value === 'yes' || value === 'no' ? undefined : 'must be yes or no'
    case 'email':
      return typeof value === 'string' && EMAIL.test(value) ? undefined : 'must be an email address'
    case 'phone':
      return typeof value === 'string' && PHONE.test(value) ? undefined : 'must be a phone number'
    case 'file':
      return typeof value === 'string' && value.length > 0 ? undefined : 'must be a file reference'
    case 'user':
      return typeof value === 'string' && value.length > 0 ? undefined : 'must be a principal'
    case 'static':
      return value === undefined ? undefined : 'is static text and takes no value'
    case 'repeating':
      return Array.isArray(value) && value.every(isRecord) ? undefined : 'must be a list of records'
  }
}

/** Whether the value is one of the field's options (FM-1). */
function isOption(options: readonly string[] | undefined, value: unknown): boolean {
  return typeof value === 'string' && (options ?? []).includes(value)
}

/** Whether the value is a list of the field's options (FM-1). */
function isOptionList(options: readonly string[] | undefined, value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isOption(options, entry))
}

/** A JSON object: not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
