// Issue #40, S03, DF-5, D2, AC-1, I14, MVP.md 5.6: the class of a definition change.
//
// Scaffold. The two classes and the shape of a difference are in place. The
// comparison arrives with the implementation; the S03 check in
// `stories/S03-edit-text/scenario.test.ts` is marked expected to fail until
// then (CONTRIBUTING.md: a failing test before the implementation).
//
// A definition change is edit-class or structural (DF-5, D2): an edit-class
// change touches a label, help text, an option list or email copy and needs
// `flow.edit`; a structural change touches the shape of the flow and needs
// `flow.build`. This milestone's definition model has steps, targets, outcomes
// and skip conditions, and no form fields or labels yet; those arrive with
// FM-1 (issue #74).

import type { FlowDefinition } from './definition.js'

/** The two classes of a definition change (DF-5, D2). */
export type ChangeClass = 'edit' | 'structural'

/** One difference between two definitions: its class and a message that names it. */
export type DefinitionChange = {
  readonly class: ChangeClass
  /** A short description of the difference, for the rejection message (DF-6). */
  readonly message: string
}

/**
 * Classify the change from one definition to the next (DF-5, D2). The
 * implementation arrives with issue #40.
 */
export function classifyChange(
  _previous: FlowDefinition,
  _next: FlowDefinition
): readonly DefinitionChange[] {
  throw new Error('edit: classifyChange is not implemented yet (issue #40)')
}
