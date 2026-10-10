// Issue #74, FM-1, FM-4, I6, A3: the form controls and their validation.
//
// The check is the work of issue #74. This is the scaffold: the function
// refuses every call, so the FM-1 test in tools/fields.test.ts fails on
// purpose. The model, the schema and the check land together with the test
// once the issue is implemented.

import type { Field } from './definition.js'

/** One validation failure: the path of the field and the reason (FM-1, FM-4). */
export type FieldError = {
  /** The path of the field that failed, so a submission can name it (FM-1). */
  readonly path: string
  /** A short reason, for the message that the submission shows. */
  readonly message: string
}

/**
 * Validate one submitted value against one field (FM-1, FM-4). The check
 * arrives with issue #74; until then the function refuses every call, so the
 * failing test is genuine.
 */
export function validateField(_field: Field, _value: unknown): FieldError | undefined {
  throw new Error('flow field: validation is not implemented (#74)')
}
