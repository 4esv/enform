// Issue #75, FM-2, FM-5, FM-1, FM-7, I6, A9: evaluate the rules of one step.
//
// FM-2: conditions on the data, the step and the user show, hide, collapse,
// require or lock sections and fields. The condition data is the instance's
// values at the root, plus the reserved `context` root that names the current
// step and the acting principal: a rule reads `context.step` and
// `context.user`. The rules apply in document order, and a later rule wins per
// target and per property. A rule whose condition is not true changes nothing,
// so the target keeps its default state.
//
// The six effects, one per target:
//   show     the target field or section is visible.
//   hide     the target field or section is not visible, and a hidden section
//            hides its fields.
//   collapse the target section is collapsed. A section also carries its
//            presentation default (`section.collapsed`, FM-1) when no rule
//            changes it. A field has no collapse surface in the view, so a
//            collapse rule on a field changes nothing.
//   require  the target field is required.
//   lock     the target field is not editable. A lock can only remove
//            editability, never grant it.
//   skip     the target drops out of the step's capture: it is absent from the
//            view's `visible` (like hide), it is not required even when the
//            field says required, and a completion does not record its value.
//            The recorded value stays on the instance. A skipped section skips
//            its fields.
// Two interactions follow: a hidden or skipped field is not required (a
// required field nobody can see is impossible to fill), and a lock never
// grants editability.
//
// The evaluation is pure and deterministic (I6): it reads only its arguments,
// never the clock, a random source or I/O. It uses the one expression
// evaluator (condition.ts, FM-5, ADR 0008). A `var` path the data does not have
// throws, so a rule that reads a field the instance does not hold makes the
// read fail rather than invent a state; the engine never pretends the
// condition was false.

import { type ConditionData, evaluate } from './condition.js'
import {
  CONTEXT_KEY,
  type FlowStep,
  fieldsOf,
  type JsonValue,
  type Rule,
  type RuleEffect,
} from './definition.js'
import type { ActorId } from './operation.js'

/** The prefix of a rule target that names a section instead of a field (FM-2). */
const SECTION_PREFIX = 'section:'

/** The state of one field after the rules of its step (FM-2). */
export type FieldRuleState = {
  /** Whether the field is shown, after the step's visible keys, the rules and a hidden section (FM-2, FM-3). */
  readonly visible: boolean
  /** Whether the field is required, after the definition and the rules; a hidden or skipped field is not required (FM-2). */
  readonly required: boolean
  /** Whether a lock rule removed the field's editability (FM-2). */
  readonly locked: boolean
  /** Whether the field dropped out of the step's capture (FM-2). */
  readonly skipped: boolean
}

/** The state of one section after the rules of its step (FM-2). */
export type SectionRuleState = {
  /** Whether the section is shown, after the rules (FM-2). */
  readonly visible: boolean
  /** Whether the section is collapsed, after its FM-1 default and the rules (FM-1, FM-2). */
  readonly collapsed: boolean
  /** Whether the section dropped out of the step's capture, which skips its fields (FM-2). */
  readonly skipped: boolean
}

/** The state of every field and section of a step after its rules (FM-2). */
export type StepRuleState = {
  readonly fields: Readonly<Record<string, FieldRuleState>>
  readonly sections: Readonly<Record<string, SectionRuleState>>
}

/** The mutable state that the rules update in document order, before it is finalised. */
type MutableStepState = {
  readonly fields: Record<string, MutableFieldState>
  readonly sections: Record<string, MutableSectionState>
  readonly sectionOf: Map<string, string>
}

type MutableFieldState = {
  visible: boolean
  required: boolean
  locked: boolean
  skipped: boolean
}

type MutableSectionState = {
  visible: boolean
  collapsed: boolean
  skipped: boolean
}

/**
 * Evaluate the rules of one step (FM-2, FM-5, I6). The state starts from the
 * step's defaults: a field is visible when the step's `visible` names it (or
 * the step declares none), required when the field says so, locked never and
 * skipped never; a section is visible, and collapsed when `section.collapsed`
 * says so. The rules then apply in document order, and a later rule wins per
 * target and per property. The result is a pure function of the step, the
 * values and the actor: it reads no clock, no random source and no I/O (I6).
 */
export function evaluateRules(
  step: FlowStep,
  values: Readonly<Record<string, JsonValue>>,
  actor: ActorId
): StepRuleState {
  const state = initialState(step)
  const data: ConditionData = { ...values, [CONTEXT_KEY]: { step: step.key, user: actor } }
  for (const rule of step.rules ?? []) {
    // The condition is a JSON Logic expression; only `true` applies the effect,
    // exactly as `isStepSkipped` reads a skip condition (WF-1).
    if (evaluate(rule.when, data) !== true) continue
    applyRule(rule, state)
  }
  finalize(state)
  return { fields: state.fields, sections: state.sections }
}

/** Seed the state from the step's defaults (FM-1, FM-2, FM-3). */
function initialState(step: FlowStep): MutableStepState {
  const sectionOf = new Map<string, string>()
  const sections: Record<string, MutableSectionState> = {}
  for (const section of step.sections ?? []) {
    sections[section.key] = { visible: true, collapsed: section.collapsed ?? false, skipped: false }
    for (const field of section.fields) sectionOf.set(field.key, section.key)
  }
  const shown = step.visible === undefined ? undefined : new Set(step.visible)
  const fields: Record<string, MutableFieldState> = {}
  for (const field of fieldsOf(step)) {
    fields[field.key] = {
      visible: shown === undefined || shown.has(field.key),
      required: field.required ?? false,
      locked: false,
      skipped: false,
    }
  }
  return { fields, sections, sectionOf }
}

/** Apply one true rule to every target it names (FM-2). */
function applyRule(rule: Rule, state: MutableStepState): void {
  for (const target of rule.targets) {
    if (target.startsWith(SECTION_PREFIX)) {
      const section = state.sections[target.slice(SECTION_PREFIX.length)]
      if (section !== undefined) applySectionEffect(rule.effect, section)
    } else {
      const field = state.fields[target]
      if (field !== undefined) applyFieldEffect(rule.effect, field)
    }
  }
}

/** Apply one effect to a field target (FM-2). */
function applyFieldEffect(effect: RuleEffect, field: MutableFieldState): void {
  switch (effect) {
    case 'show':
      field.visible = true
      return
    case 'hide':
      field.visible = false
      return
    case 'require':
      field.required = true
      return
    case 'lock':
      field.locked = true
      return
    case 'skip':
      field.skipped = true
      return
    case 'collapse':
      // A field has no collapse surface in the view (FM-2); a section carries it.
      return
  }
}

/** Apply one effect to a section target (FM-1, FM-2). */
function applySectionEffect(effect: RuleEffect, section: MutableSectionState): void {
  switch (effect) {
    case 'show':
      section.visible = true
      return
    case 'hide':
      section.visible = false
      return
    case 'collapse':
      section.collapsed = true
      return
    case 'skip':
      section.skipped = true
      return
    case 'require':
    case 'lock':
      // `require` and `lock` name a field (FM-2); a section has no property for them.
      return
  }
}

/** Resolve the section onto its fields and the two interactions, then the state is final (FM-2). */
function finalize(state: MutableStepState): void {
  for (const key of Object.keys(state.fields)) {
    const field = state.fields[key]
    const sectionKey = state.sectionOf.get(key)
    const section = sectionKey === undefined ? undefined : state.sections[sectionKey]
    field.visible = field.visible && (section?.visible ?? true)
    field.skipped = field.skipped || (section?.skipped ?? false)
    // A hidden or skipped field is not required (FM-2): nobody can fill a field
    // they cannot see.
    field.required = field.required && field.visible && !field.skipped
  }
}
