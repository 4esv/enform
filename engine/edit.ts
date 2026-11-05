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
// Issue #256, DF-6: the comparison names every field-level difference with
// the path it sits at and the value before and after, so a diff view and a
// refusal point at the exact place. A label, help text or an option list is
// edit-class; a field, a control, a requirement, a section, a rule, a timer, a
// takeover and a flow setting are structural.

import type { Field, FlowDefinition, FlowStep, JsonValue } from './definition.js'

/** The two classes of a definition change (DF-5, D2). */
export type ChangeClass = 'edit' | 'structural'

/**
 * One difference between two definitions: its class, a message that names it,
 * the path it sits at (DF-6, #256) and, when one place changed, the value
 * before and after. The path is a JSON-pointer-like string that names steps,
 * sections and fields by key, for example
 * `/steps/request/sections/about/fields/summary/label`.
 */
export type DefinitionChange = {
  readonly class: ChangeClass
  /** A short description of the difference, for the rejection message (DF-6). */
  readonly message: string
  /** Where the difference sits (DF-6). */
  readonly path: string
  /** The value before the change, when one place changed; absent for an addition. */
  readonly before?: JsonValue
  /** The value after the change, when one place changed; absent for a removal. */
  readonly after?: JsonValue
}

/**
 * Classify the change from one definition to the next (DF-5, DF-6, D2). It
 * returns one entry per difference, in a stable order: the schema version and
 * the flow settings, the step order, the removed and the added steps, then
 * the change within each shared step, field by field. An empty list means
 * the two definitions are equal. The one edit class is a label, help text or
 * an option list; every other difference changes the shape of the flow and is
 * structural.
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
      path: '/schemaVersion',
      before: previous.schemaVersion,
      after: next.schemaVersion,
    })
  }
  for (const setting of ['anonymous', 'undoHours', 'finalStep'] as const) {
    changes.push(
      ...classifyValue(
        `/${setting}`,
        `the flow setting ${setting}`,
        previous[setting],
        next[setting]
      )
    )
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
    changes.push({
      class: 'structural',
      message: 'the order of the steps changed',
      path: '/steps',
      before: beforeKeys,
      after: afterKeys,
    })
  }
  for (const step of previous) {
    if (!after.has(step.key)) {
      changes.push({
        class: 'structural',
        message: `a step was removed: ${step.key}`,
        path: `/steps/${step.key}`,
      })
    }
  }
  for (const step of next) {
    if (!before.has(step.key)) {
      changes.push({
        class: 'structural',
        message: `a step was added: ${step.key}`,
        path: `/steps/${step.key}`,
      })
    }
  }
  for (const step of next) {
    const earlier = before.get(step.key)
    if (earlier !== undefined) changes.push(...classifyStep(earlier, step))
  }
  return changes
}

/**
 * Classify the change within one shared step: its targets, its outcomes, its
 * condition, its form (flat fields or sections), its visibility and
 * editability, its rules, its takeover and its timers.
 */
function classifyStep(previous: FlowStep, next: FlowStep): readonly DefinitionChange[] {
  const path = `/steps/${next.key}`
  const changes: DefinitionChange[] = []
  if (!same(previous.targets, next.targets)) {
    changes.push({
      class: 'structural',
      message: `a target of step ${next.key} changed`,
      path: `${path}/targets`,
      before: previous.targets as unknown as JsonValue,
      after: next.targets as unknown as JsonValue,
    })
  }
  changes.push(
    ...classifyOptions(
      `${path}/outcomes`,
      `step ${next.key}`,
      'outcomes',
      previous.outcomes,
      next.outcomes
    )
  )
  changes.push(...classifyCondition(next.key, path, previous.skipWhen, next.skipWhen))
  changes.push(...classifyForm(next.key, path, previous, next))
  for (const setting of [
    'visible',
    'editable',
    'rules',
    'takeover',
    'idleMinutes',
    'reminderMinutes',
    'deadlineMinutes',
    'escalationTargets',
  ] as const) {
    changes.push(
      ...classifyValue(
        `${path}/${setting}`,
        `the ${setting} of step ${next.key}`,
        previous[setting] as JsonValue | undefined,
        next[setting] as JsonValue | undefined
      )
    )
  }
  return changes
}

/**
 * Classify the change to a step's form (FM-1, DF-5): flat fields, or
 * sections with their fields. A step that moves from flat fields to sections
 * (or back) changes its shape. Within the form, a field is matched by key.
 */
function classifyForm(
  key: string,
  path: string,
  previous: FlowStep,
  next: FlowStep
): readonly DefinitionChange[] {
  const changes: DefinitionChange[] = []
  if ((previous.sections === undefined) !== (next.sections === undefined)) {
    changes.push({
      class: 'structural',
      message: `the form of step ${key} changed between flat fields and sections`,
      path: `${path}/sections`,
    })
    return changes
  }
  if (next.sections !== undefined) {
    const before = new Map((previous.sections ?? []).map((section) => [section.key, section]))
    const after = new Map(next.sections.map((section) => [section.key, section]))
    for (const section of previous.sections ?? []) {
      if (!after.has(section.key)) {
        changes.push({
          class: 'structural',
          message: `a section was removed from step ${key}: ${section.key}`,
          path: `${path}/sections/${section.key}`,
        })
      }
    }
    for (const section of next.sections) {
      const earlier = before.get(section.key)
      const sectionPath = `${path}/sections/${section.key}`
      if (earlier === undefined) {
        changes.push({
          class: 'structural',
          message: `a section was added to step ${key}: ${section.key}`,
          path: sectionPath,
        })
        continue
      }
      changes.push(
        ...classifyValue(
          `${sectionPath}/collapsed`,
          `the collapsed default of section ${section.key} in step ${key}`,
          earlier.collapsed,
          section.collapsed
        )
      )
      changes.push(...classifyFields(key, `${sectionPath}/fields`, earlier.fields, section.fields))
    }
    const beforeKeys = (previous.sections ?? []).map((section) => section.key)
    const afterKeys = next.sections.map((section) => section.key)
    if (sameSet(beforeKeys, afterKeys) && !sameOrder(beforeKeys, afterKeys)) {
      changes.push({
        class: 'structural',
        message: `the order of the sections of step ${key} changed`,
        path: `${path}/sections`,
        before: beforeKeys,
        after: afterKeys,
      })
    }
    return changes
  }
  changes.push(...classifyFields(key, `${path}/fields`, previous.fields ?? [], next.fields ?? []))
  return changes
}

/** Classify the change between two field lists of one step or section (FM-1, DF-5). */
function classifyFields(
  step: string,
  path: string,
  previous: readonly Field[],
  next: readonly Field[]
): readonly DefinitionChange[] {
  const changes: DefinitionChange[] = []
  const before = new Map(previous.map((field) => [field.key, field]))
  const after = new Map(next.map((field) => [field.key, field]))
  for (const field of previous) {
    if (!after.has(field.key)) {
      changes.push({
        class: 'structural',
        message: `a field was removed from step ${step}: ${field.key}`,
        path: `${path}/${field.key}`,
      })
    }
  }
  for (const field of next) {
    const earlier = before.get(field.key)
    const fieldPath = `${path}/${field.key}`
    if (earlier === undefined) {
      changes.push({
        class: 'structural',
        message: `a field was added to step ${step}: ${field.key}`,
        path: fieldPath,
      })
      continue
    }
    if (earlier.label !== field.label) {
      changes.push({
        class: 'edit',
        message: `the label of field ${field.key} in step ${step} changed`,
        path: `${fieldPath}/label`,
        ...(earlier.label === undefined ? {} : { before: earlier.label }),
        ...(field.label === undefined ? {} : { after: field.label }),
      })
    }
    if (earlier.control !== field.control) {
      changes.push({
        class: 'structural',
        message: `the control of field ${field.key} in step ${step} changed from ${earlier.control} to ${field.control}`,
        path: `${fieldPath}/control`,
        before: earlier.control,
        after: field.control,
      })
    }
    changes.push(
      ...classifyValue(
        `${fieldPath}/required`,
        `the required setting of field ${field.key} in step ${step}`,
        earlier.required,
        field.required
      )
    )
    changes.push(
      ...classifyOptions(
        `${fieldPath}/options`,
        `field ${field.key} in step ${step}`,
        'options',
        earlier.options,
        field.options
      )
    )
    changes.push(
      ...classifyValue(
        `${fieldPath}/default`,
        `the default of field ${field.key} in step ${step}`,
        earlier.default,
        field.default
      )
    )
    changes.push(
      ...classifyValue(
        `${fieldPath}/optionsFrom`,
        `the option source of field ${field.key} in step ${step}`,
        earlier.optionsFrom,
        field.optionsFrom
      )
    )
    changes.push(
      ...classifyValue(
        `${fieldPath}/valueFrom`,
        `the value source of field ${field.key} in step ${step}`,
        earlier.valueFrom,
        field.valueFrom
      )
    )
  }
  const beforeKeys = previous.map((field) => field.key)
  const afterKeys = next.map((field) => field.key)
  if (sameSet(beforeKeys, afterKeys) && !sameOrder(beforeKeys, afterKeys)) {
    changes.push({
      class: 'structural',
      message: `the order of the fields of step ${step} changed`,
      path,
      before: beforeKeys,
      after: afterKeys,
    })
  }
  return changes
}

/**
 * Classify the change to an option list (DF-5, D2): a step's outcomes or a
 * field's options. Adding, removing or reordering an option is edit-class.
 * Adding or removing the list itself adds or removes a property, which is
 * structural.
 */
function classifyOptions(
  path: string,
  owner: string,
  name: 'outcomes' | 'options',
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined
): readonly DefinitionChange[] {
  if (previous === undefined && next === undefined) return []
  if (previous === undefined) {
    return [
      {
        class: 'structural',
        message: `a field was added to ${owner}: ${name}`,
        path,
        after: [...(next ?? [])],
      },
    ]
  }
  if (next === undefined) {
    return [
      {
        class: 'structural',
        message: `a field was removed from ${owner}: ${name}`,
        path,
        before: [...previous],
      },
    ]
  }
  const changes: DefinitionChange[] = []
  const before = new Set(previous)
  const after = new Set(next)
  const values = { path, before: [...previous], after: [...next] }
  for (const option of next) {
    if (!before.has(option)) {
      changes.push({
        class: 'edit',
        message: `an option was added to ${owner}: ${option}`,
        ...values,
      })
    }
  }
  for (const option of previous) {
    if (!after.has(option)) {
      changes.push({
        class: 'edit',
        message: `an option was removed from ${owner}: ${option}`,
        ...values,
      })
    }
  }
  if (changes.length === 0 && !sameOrder(previous, next)) {
    changes.push({ class: 'edit', message: `the ${name} of ${owner} were reordered`, ...values })
  }
  return changes
}

/**
 * Classify the change to a step's skip condition (WF-1, S05). The condition is
 * part of the flow, not its text, so any change to it is structural.
 */
function classifyCondition(
  key: string,
  path: string,
  previous: JsonValue | undefined,
  next: JsonValue | undefined
): readonly DefinitionChange[] {
  const at = `${path}/skipWhen`
  if (previous === undefined && next === undefined) return []
  if (previous === undefined) {
    return [
      {
        class: 'structural',
        message: `a field was added to step ${key}: skipWhen`,
        path: at,
        after: next,
      },
    ]
  }
  if (next === undefined) {
    return [
      {
        class: 'structural',
        message: `a field was removed from step ${key}: skipWhen`,
        path: at,
        before: previous,
      },
    ]
  }
  if (!same(previous, next)) {
    return [
      {
        class: 'structural',
        message: `the condition of step ${key} changed`,
        path: at,
        before: previous,
        after: next,
      },
    ]
  }
  return []
}

/** Classify one structural value: added, removed or changed at a path. */
function classifyValue(
  path: string,
  what: string,
  previous: JsonValue | undefined,
  next: JsonValue | undefined
): readonly DefinitionChange[] {
  if (previous === undefined && next === undefined) return []
  if (previous === undefined) {
    return [{ class: 'structural', message: `${what} was added`, path, after: next }]
  }
  if (next === undefined) {
    return [{ class: 'structural', message: `${what} was removed`, path, before: previous }]
  }
  if (same(previous, next)) return []
  return [{ class: 'structural', message: `${what} changed`, path, before: previous, after: next }]
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
