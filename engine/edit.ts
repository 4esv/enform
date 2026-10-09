// Issue #40, S03, DF-5, D2, AC-1, I14, MVP.md 5.6: the class of a definition change.
//
// A definition change is one of two classes (DF-5, D2). An edit-class change
// touches a label, help text, an option list or email copy, and needs the
// scope `flow.edit`. A structural change touches the shape of the flow: a
// field, a step or a target, and needs the scope `flow.build`. This module
// compares two definitions and names every difference, so the push path can
// reject a structural change and say which change and which scope it needs
// (AC-1). The comparison is a pure function of the two definitions (I6): it
// reads no clock and no random source.
//
// This milestone's definition model has steps, targets, outcomes and skip
// conditions; it has no form fields or labels yet. Those arrive with FM-1
// (issue #74). The one edit-class change that this model can express is a
// change to a step's option list, so the S03 test proves the classification
// and the scope guard with an option change (edit-class) and a step, target or
// property change (structural).

import type { FlowDefinition, FlowStep, JsonValue } from './definition.js'

/** The two classes of a definition change (DF-5, D2). */
export type ChangeClass = 'edit' | 'structural'

/** One difference between two definitions: its class and a message that names it. */
export type DefinitionChange = {
  readonly class: ChangeClass
  /** A short description of the difference, for the rejection message (DF-6). */
  readonly message: string
}

/**
 * Classify the change from one definition to the next (DF-5, D2). It returns
 * one entry per difference, in a stable order: the schema version, the step
 * order, the removed and the added steps, then the change within each shared
 * step. An empty list means the two definitions are equal.
 */
export function classifyChange(
  previous: FlowDefinition,
  next: FlowDefinition
): readonly DefinitionChange[] {
  const changes: DefinitionChange[] = []
  if (previous.schemaVersion !== next.schemaVersion) {
    changes.push({
      class: 'structural',
      message: `the schema version changed from ${previous.schemaVersion} to ${next.schemaVersion}`,
    })
  }
  changes.push(...classifySteps(previous.steps, next.steps))
  return changes
}

/** Classify the change between two step lists: order, removed, added, then each shared step. */
function classifySteps(
  previous: readonly FlowStep[],
  next: readonly FlowStep[]
): readonly DefinitionChange[] {
  const changes: DefinitionChange[] = []
  const before = new Map(previous.map((step) => [step.key, step]))
  const after = new Map(next.map((step) => [step.key, step]))
  const beforeKeys = previous.map((step) => step.key)
  const afterKeys = next.map((step) => step.key)
  if (sameSet(beforeKeys, afterKeys) && !sameOrder(beforeKeys, afterKeys)) {
    changes.push({ class: 'structural', message: 'the order of the steps changed' })
  }
  for (const step of previous) {
    if (!after.has(step.key)) {
      changes.push({ class: 'structural', message: `a step was removed: ${step.key}` })
    }
  }
  for (const step of next) {
    if (!before.has(step.key)) {
      changes.push({ class: 'structural', message: `a step was added: ${step.key}` })
    }
  }
  for (const step of next) {
    const earlier = before.get(step.key)
    if (earlier !== undefined) changes.push(...classifyStep(earlier, step))
  }
  return changes
}

/** Classify the change within one shared step: its targets, its options and its condition. */
function classifyStep(previous: FlowStep, next: FlowStep): readonly DefinitionChange[] {
  const changes: DefinitionChange[] = []
  if (!same(previous.targets, next.targets)) {
    changes.push({ class: 'structural', message: `a target of step ${next.key} changed` })
  }
  changes.push(...classifyOptions(next.key, previous.outcomes, next.outcomes))
  changes.push(...classifyCondition(next.key, previous.skipWhen, next.skipWhen))
  return changes
}

/**
 * Classify the change to a step's option list (DF-5, D2). Adding, removing or
 * renaming an option is edit-class. Adding or removing the option list itself
 * adds or removes a property of the step, which is structural.
 */
function classifyOptions(
  key: string,
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined
): readonly DefinitionChange[] {
  if (previous === undefined && next === undefined) return []
  if (previous === undefined) {
    return [{ class: 'structural', message: `a field was added to step ${key}: outcomes` }]
  }
  if (next === undefined) {
    return [{ class: 'structural', message: `a field was removed from step ${key}: outcomes` }]
  }
  const changes: DefinitionChange[] = []
  const before = new Set(previous)
  const after = new Set(next)
  for (const option of next) {
    if (!before.has(option)) {
      changes.push({ class: 'edit', message: `an option was added to step ${key}: ${option}` })
    }
  }
  for (const option of previous) {
    if (!after.has(option)) {
      changes.push({ class: 'edit', message: `an option was removed from step ${key}: ${option}` })
    }
  }
  if (changes.length === 0 && !sameOrder(previous, next)) {
    changes.push({ class: 'edit', message: `the options of step ${key} were reordered` })
  }
  return changes
}

/**
 * Classify the change to a step's skip condition (WF-1, S05). The condition is
 * part of the flow, not its text, so any change to it is structural.
 */
function classifyCondition(
  key: string,
  previous: JsonValue | undefined,
  next: JsonValue | undefined
): readonly DefinitionChange[] {
  if (previous === undefined && next === undefined) return []
  if (previous === undefined) {
    return [{ class: 'structural', message: `a field was added to step ${key}: skipWhen` }]
  }
  if (next === undefined) {
    return [{ class: 'structural', message: `a field was removed from step ${key}: skipWhen` }]
  }
  if (!same(previous, next)) {
    return [{ class: 'structural', message: `the condition of step ${key} changed` }]
  }
  return []
}

/** The two lists hold the same values, in any order. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(left)
  return right.every((value) => seen.has(value))
}

/** The two lists hold the same values, in the same order. */
function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Deep equality for the JSON values of a definition. */
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => same(entry, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => same(left[key], right[key]))
  }
  return false
}

/** A JSON object: not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
