// Issue #75, FM-2, FM-5, FM-1, FM-7, I6, A9: evaluate the rules of one step.
// The shape lands first, so the checks compile: the evaluation follows, and the
// checks that expect a rule state fail as marked.

import type { FlowStep, JsonValue } from './definition.js'
import type { ActorId } from './operation.js'

/** The state of one field after the rules of its step (FM-2). */
export type FieldRuleState = {
  readonly visible: boolean
  readonly required: boolean
  readonly locked: boolean
  readonly skipped: boolean
}

/** The state of one section after the rules of its step (FM-2). */
export type SectionRuleState = {
  readonly visible: boolean
  readonly collapsed: boolean
  readonly skipped: boolean
}

/** The state of every field and section of a step after its rules (FM-2). */
export type StepRuleState = {
  readonly fields: Readonly<Record<string, FieldRuleState>>
  readonly sections: Readonly<Record<string, SectionRuleState>>
}

/** Evaluate the rules of one step (FM-2); the implementation follows. */
export function evaluateRules(
  _step: FlowStep,
  _values: Readonly<Record<string, JsonValue>>,
  _actor: ActorId
): StepRuleState {
  throw new Error('rules: the evaluation of a step follows (#75)')
}
