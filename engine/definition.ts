// Issue #15, #71, #74, #170, I9, ID-3, DF-1, DF-4, A3, FM-1, FM-2, FM-3,
// FM-5, FM-6: the flow definition file, its canonical round trip, the
// anonymous setting, the form fields, sections, conditions and per-step
// visibility and rules.

import { configType } from './config.js'
import { type ActorId, createOperation, type Operation, type OperationDeps } from './operation.js'

/**
 * One integer `schemaVersion` of the flow definition format (DF-1, MVP.md
 * 9.1). The engine reads every earlier value and writes only the latest
 * (9.3); at this milestone the latest is 2.
 */
export const SCHEMA_VERSION = 2

/** A JSON value, the shape of a JSON Logic expression tree (FM-5, ADR 0008). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** The six kinds of target (AS-1). */
export const TARGET_KINDS = ['user', 'group', 'team', 'field', 'starter', 'manager-of'] as const

/** One kind of target (AS-1). */
export type TargetKind = (typeof TARGET_KINDS)[number]

/**
 * The recipient of a task (MVP.md 3, AS-1). Exactly one key names the kind:
 * `user`, `group` and `team` hold an immutable principal ID (ID-4); `field`
 * holds a form field key; `starter` and `manager-of` are the dynamic targets
 * of AS-1, for example `{ "starter": "starter" }` and
 * `{ "manager-of": "starter" }`.
 */
export type Target =
  | { readonly user: string }
  | { readonly group: string }
  | { readonly team: string }
  | { readonly field: string }
  | { readonly starter: string }
  | { readonly 'manager-of': string }

/**
 * The sixteen form controls (FM-1, A3). `control` of a field is one of these,
 * and `validateField` (fields.ts) checks a submitted value against it (FM-4).
 */
export const CONTROL_TYPES = [
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
] as const

/** One kind of form control (FM-1). */
export type ControlType = (typeof CONTROL_TYPES)[number]

/** The six effects of a rule (FM-2, FM-5). */
export const RULE_EFFECTS = ['show', 'hide', 'collapse', 'require', 'lock', 'skip'] as const

/**
 * The reserved root that a rule condition reads the current step and the
 * acting principal from (FM-2): the condition data is the instance's values
 * plus `context: { step, user }`. No field may use the key, so nothing can
 * shadow the root; the parser refuses one.
 */
export const CONTEXT_KEY = 'context'

/** One effect of a rule (FM-2, FM-5). */
export type RuleEffect = (typeof RULE_EFFECTS)[number]

/**
 * One rule of a step (FM-2, FM-5). `when` is a JSON Logic condition.
 * `effect` is one of the six effects: show, hide, collapse, require, lock or
 * skip. `targets` names the fields and sections the effect applies to; a
 * section target is `section:` followed by the section key.
 */
export type Rule = {
  readonly when: JsonValue
  readonly effect: RuleEffect
  readonly targets: readonly string[]
}

/**
 * One form field of a step (FM-1, A3). `key` is the field's stable name within
 * the flow. `control` is one of the sixteen FM-1 controls. `label` is the
 * human label the form shows; absent means the form shows the key. A choice
 * control (`select`, `multi-select`, `radio`) lists the values it accepts in
 * `options`; the other controls ignore the list. `required` makes the field
 * mandatory, `default` is its default value, and `optionsFrom` and `valueFrom`
 * name the connector read operations that supply the option list and the
 * default (FM-6).
 */
export type Field = {
  readonly key: string
  readonly control: ControlType
  readonly label?: string
  readonly options?: readonly string[]
  readonly required?: boolean
  readonly default?: JsonValue
  readonly optionsFrom?: string
  readonly valueFrom?: string
}

/**
 * One named group of fields within a step (FM-1). `collapsed` is an optional
 * presentation default.
 */
export type Section = {
  readonly key: string
  readonly fields: readonly Field[]
  readonly collapsed?: boolean
}

/**
 * One stage of a flow (MVP.md 3, WF-1, WF-2). `targets` are the recipients of
 * the task that the step creates. A step shows its form either as flat
 * `fields` or as `sections`, never both (FM-1). `visible` and `editable` name
 * the field keys the step shows and the actor may edit (FM-3); absent visible
 * means every field, and absent editable means none. `outcomes` are the names
 * an actor can choose (WF-2). `skipWhen` is a JSON Logic expression; when it
 * is true the step is skipped (WF-1, S05). `rules` are the conditions that
 * show, hide, collapse, require, lock or skip fields and sections (FM-2, FM-5).
 */
export type FlowStep = {
  readonly key: string
  readonly targets: readonly Target[]
  readonly fields?: readonly Field[]
  readonly sections?: readonly Section[]
  readonly visible?: readonly string[]
  readonly editable?: readonly string[]
  readonly outcomes?: readonly string[]
  readonly skipWhen?: JsonValue
  readonly rules?: readonly Rule[]
}

/** One flow, as one JSON document (DF-1). */
export type FlowDefinition = {
  readonly schemaVersion: number
  /**
   * Whether a visitor who is not signed in may open the form (ID-3). The
   * setting is explicit and per flow; absent means false, so the default sends
   * the visitor to SSO (ID-2).
   */
  readonly anonymous?: boolean
  readonly steps: readonly FlowStep[]
}

/**
 * Every field of a step in definition order (FM-1): its flat fields or its
 * sections' fields. A step declares one or the other, never both, and the
 * rules and the completion both walk the fields in this one order.
 */
export function fieldsOf(step: FlowStep): readonly Field[] {
  if (step.fields !== undefined) return step.fields
  return (step.sections ?? []).flatMap((section) => section.fields)
}

/**
 * Parse a flow definition file to a definition (I9, DF-1). The text is JSON
 * and the format is versioned by its integer `schemaVersion` (9.1). The engine
 * reads a v1 file and migrates it to v2, and reads a v2 file as written (9.3).
 * `serialize` imposes the canonical v2 form, so `serialize(parse(file))` is
 * `file` again for a canonical v2 file (I9).
 */
export function parse(text: string): FlowDefinition {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('flow definition: the document is not valid JSON')
  }
  return readDefinition(value)
}

/**
 * Serialize a definition to its canonical v2 file form (I9, DF-4). The form is
 * stable and byte-for-byte reproducible: the flow, a step, a section, a rule,
 * a field and a target have a fixed key order, the optional settings appear
 * only when the definition has them, a nested JSON value sorts its object
 * keys, the indent is two spaces, and the file ends with one newline. `parse`
 * then `serialize` reproduces a canonical v2 file exactly (I9).
 */
export function serialize(definition: FlowDefinition): string {
  return `${JSON.stringify(canonicalDefinition(definition), null, 2)}\n`
}

/** The event type of a definition change (I14, via `config.definition`). */
export const DEFINITION_CHANGED = configType('definition')

/**
 * Convert a definition to the operation that records it (I9, I14, DF-4). The
 * payload is the definition itself. The operation omits the actor: the caller
 * that holds the principal adds the attribution, and I14 keeps every
 * behavior-affecting change attributed on the log.
 */
export function definitionToOperation(definition: FlowDefinition, deps: OperationDeps): Operation {
  return createOperation(DEFINITION_CHANGED, definition, deps)
}

/**
 * Convert the operation that records a definition back to a definition (I9).
 * It is the inverse of `definitionToOperation`, so a definition survives the
 * trip to the log and back unchanged. The flow lifecycle names the changed
 * flow on the operation (`{ flow, definition }`, flow.ts), while
 * `definitionToOperation` writes the definition alone; both shapes read back
 * here.
 */
export function definitionFromOperation(operation: Operation): FlowDefinition {
  if (operation.type !== DEFINITION_CHANGED) {
    throw new Error(`flow definition: ${operation.type} is not ${DEFINITION_CHANGED}`)
  }
  const payload = operation.payload
  // SAFETY: a lifecycle push carries the definition under `definition`
  // (flow.ts), and every other writer writes the FlowDefinition itself. A
  // definition has no top-level `definition` key, so the two cannot collide.
  return (isRecord(payload.definition) ? payload.definition : payload) as unknown as FlowDefinition
}

/**
 * Read a definition from parsed JSON (DF-1, 9.3). A v1 document is read with
 * the v1 rules first, then migrated forward; a v2 document is read with the v2
 * rules. Every other schemaVersion is refused.
 */
function readDefinition(body: unknown): FlowDefinition {
  if (!isRecord(body)) throw new Error('flow definition: the document is not an object')
  if (body.schemaVersion === 1) return migrateV1(readV1Definition(body))
  if (body.schemaVersion === 2) return readV2Definition(body)
  throw new Error('flow definition: schemaVersion must be 1 or 2')
}

/**
 * Read a v1 definition with the v1 rules only, so a v1 document that v1
 * rejected is still rejected (9.3). The v1 reader knows none of the v2 parts.
 */
function readV1Definition(body: unknown): FlowDefinition {
  if (!isRecord(body)) throw new Error('flow definition: the document is not an object')
  if (body.schemaVersion !== 1) {
    throw new Error('flow definition: schemaVersion must be 1')
  }
  if (!Array.isArray(body.steps)) throw new Error('flow definition: steps must be an array')
  const definition: {
    schemaVersion: number
    anonymous?: boolean
    steps: readonly FlowStep[]
  } = { schemaVersion: 1, steps: body.steps.map(readV1Step) }
  const anonymous = readAnonymous(body.anonymous)
  if (anonymous !== undefined) definition.anonymous = anonymous
  return definition
}

/**
 * The forward migrator of MVP.md 9.3: turn a v1 definition into a v2
 * definition. The v1 read above has already rejected everything v1 rejects.
 * The only change is the version: a v1 definition has no sections, visibility,
 * editability or rules, so none of those keys appear. The function is pure
 * (I6).
 */
function migrateV1(definition: FlowDefinition): FlowDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(definition.anonymous !== undefined ? { anonymous: definition.anonymous } : {}),
    steps: definition.steps.map((step) => ({
      key: step.key,
      targets: step.targets,
      ...(step.fields !== undefined ? { fields: step.fields } : {}),
      ...(step.outcomes !== undefined ? { outcomes: step.outcomes } : {}),
      ...(step.skipWhen !== undefined ? { skipWhen: step.skipWhen } : {}),
    })),
  }
}

/** Read a v2 definition with the v2 rules, and reject a document v2 does not allow. */
function readV2Definition(body: unknown): FlowDefinition {
  if (!isRecord(body)) throw new Error('flow definition: the document is not an object')
  if (!Array.isArray(body.steps)) throw new Error('flow definition: steps must be an array')
  const definition: {
    schemaVersion: number
    anonymous?: boolean
    steps: readonly FlowStep[]
  } = { schemaVersion: SCHEMA_VERSION, steps: body.steps.map(readV2Step) }
  const anonymous = readAnonymous(body.anonymous)
  if (anonymous !== undefined) definition.anonymous = anonymous
  return definition
}

/**
 * Read the optional anonymous setting of a flow (ID-3). Absent means false, so
 * the flow requires sign-in (ID-2). A present value must be a boolean.
 */
function readAnonymous(body: unknown): boolean | undefined {
  if (body === undefined) return undefined
  if (typeof body !== 'boolean') {
    throw new Error('flow definition: anonymous must be a boolean (ID-3)')
  }
  return body
}

/**
 * Whether a flow lets a visitor who is not signed in open its form (ID-3).
 * Anonymous access is off unless the flow sets the setting to true, so the
 * default sends the visitor to SSO (ID-2). The function is pure and
 * deterministic (I6).
 */
export function allowsAnonymous(definition: FlowDefinition): boolean {
  return definition.anonymous === true
}

/**
 * Whether an actor may view a flow (ID-3). A signed-in actor may always view
 * the flow; a visitor who is not signed in may view it only when the flow
 * allows anonymous access. Viewing is not starting: a start still requires a
 * signed-in principal (ID-2). The function is pure and deterministic (I6).
 */
export function canView(definition: FlowDefinition, actor: ActorId | undefined): boolean {
  return actor !== undefined || allowsAnonymous(definition)
}

/**
 * Read one v1 step: a key, its targets, and the optional flat fields, outcomes
 * and skip condition. The v1 step knows none of the v2 parts.
 */
function readV1Step(body: unknown): FlowStep {
  if (!isRecord(body)) throw new Error('flow definition: a step is not an object')
  if (typeof body.key !== 'string') throw new Error('flow definition: a step has no key')
  const step: {
    key: string
    targets: readonly Target[]
    fields?: readonly Field[]
    outcomes?: readonly string[]
    skipWhen?: JsonValue
  } = { key: body.key, targets: readTargets(body.targets) }
  const fields = readV1Fields(body.fields)
  if (fields !== undefined) step.fields = fields
  const outcomes = readOutcomes(body.outcomes)
  if (outcomes !== undefined) step.outcomes = outcomes
  if (body.skipWhen !== undefined) step.skipWhen = body.skipWhen as JsonValue
  return step
}

/** Read the optional flat fields of a v1 step (FM-1). */
function readV1Fields(body: unknown): readonly Field[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body)) throw new Error('flow definition: fields must be an array')
  return body.map(readV1Field)
}

/**
 * Read one v1 field: a key, one of the sixteen controls, and the optional
 * option list of a choice control (FM-1). An unknown control is refused. The
 * v1 field knows none of the v2 parts.
 */
function readV1Field(body: unknown): Field {
  if (!isRecord(body)) throw new Error('flow definition: a field is not an object')
  if (typeof body.key !== 'string') throw new Error('flow definition: a field has no key')
  refuseReservedKey(body.key)
  if (!CONTROL_TYPES.includes(body.control as ControlType)) {
    throw new Error(`flow definition: ${String(body.control)} is not a control type (FM-1)`)
  }
  const field: { key: string; control: ControlType; options?: readonly string[] } = {
    key: body.key,
    control: body.control as ControlType,
  }
  const options = readOptions(body.options)
  if (options !== undefined) field.options = options
  return field
}

/**
 * Read one v2 step: a key, its targets, and the optional fields, sections,
 * visible and editable field keys, outcomes, skip condition and rules.
 */
function readV2Step(body: unknown): FlowStep {
  if (!isRecord(body)) throw new Error('flow definition: a step is not an object')
  if (typeof body.key !== 'string') throw new Error('flow definition: a step has no key')
  const fields = readV2Fields(body.fields)
  const sections = readSections(body.sections)
  if (fields !== undefined && sections !== undefined) {
    throw new Error('flow definition: a step cannot have both fields and sections (FM-1)')
  }
  const step: {
    key: string
    targets: readonly Target[]
    fields?: readonly Field[]
    sections?: readonly Section[]
    visible?: readonly string[]
    editable?: readonly string[]
    outcomes?: readonly string[]
    skipWhen?: JsonValue
    rules?: readonly Rule[]
  } = { key: body.key, targets: readTargets(body.targets) }
  if (fields !== undefined) step.fields = fields
  if (sections !== undefined) step.sections = sections

  const fieldKeys = new Set<string>()
  for (const field of fields ?? []) fieldKeys.add(field.key)
  for (const section of sections ?? []) {
    for (const field of section.fields) fieldKeys.add(field.key)
  }
  const sectionKeys = new Set((sections ?? []).map((section) => section.key))

  const visible = readFieldKeys(body.visible, 'visible', fieldKeys)
  if (visible !== undefined) step.visible = visible
  const editable = readFieldKeys(body.editable, 'editable', fieldKeys)
  if (editable !== undefined) step.editable = editable

  const outcomes = readOutcomes(body.outcomes)
  if (outcomes !== undefined) step.outcomes = outcomes
  if (body.skipWhen !== undefined) step.skipWhen = body.skipWhen as JsonValue
  const rules = readRules(body.rules, fieldKeys, sectionKeys)
  if (rules !== undefined) step.rules = rules
  return step
}

/** Read the targets of a step. */
function readTargets(body: unknown): readonly Target[] {
  if (!Array.isArray(body)) throw new Error('flow definition: targets must be an array')
  return body.map(readTarget)
}

/** Read one target: exactly one kind key, whose value is a string (AS-1). */
function readTarget(body: unknown): Target {
  if (!isRecord(body)) throw new Error('flow definition: a target is not an object')
  const keys = Object.keys(body)
  if (keys.length !== 1) throw new Error('flow definition: a target names exactly one kind')
  const kind = keys[0]
  if (!TARGET_KINDS.includes(kind as TargetKind)) {
    throw new Error(`flow definition: ${kind} is not a target kind (AS-1)`)
  }
  if (typeof body[kind] !== 'string') {
    throw new Error('flow definition: a target value must be a string')
  }
  // The one key is a TargetKind, which the check above established.
  return { [kind]: body[kind] } as Target
}

/** Read the optional flat fields of a v2 step (FM-1). */
function readV2Fields(body: unknown): readonly Field[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body)) throw new Error('flow definition: fields must be an array')
  return body.map(readV2Field)
}

/**
 * Read one v2 field: a key, one of the sixteen controls, the optional human
 * label, the optional option list of a choice control (FM-1), and the optional
 * required, default and connector-supplied values (FM-6). An unknown control
 * or a malformed label is refused.
 */
function readV2Field(body: unknown): Field {
  if (!isRecord(body)) throw new Error('flow definition: a field is not an object')
  if (typeof body.key !== 'string') throw new Error('flow definition: a field has no key')
  refuseReservedKey(body.key)
  if (!CONTROL_TYPES.includes(body.control as ControlType)) {
    throw new Error(`flow definition: ${String(body.control)} is not a control type (FM-1)`)
  }
  const field: {
    key: string
    control: ControlType
    label?: string
    options?: readonly string[]
    required?: boolean
    default?: JsonValue
    optionsFrom?: string
    valueFrom?: string
  } = { key: body.key, control: body.control as ControlType }
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.length === 0) {
      throw new Error('flow definition: label must be a non-empty string (FM-1)')
    }
    field.label = body.label
  }
  const options = readOptions(body.options)
  if (options !== undefined) field.options = options
  if (body.required !== undefined) {
    if (typeof body.required !== 'boolean') {
      throw new Error('flow definition: required must be a boolean (FM-1)')
    }
    field.required = body.required
  }
  if (body.default !== undefined) field.default = body.default as JsonValue
  if (body.optionsFrom !== undefined) {
    if (typeof body.optionsFrom !== 'string') {
      throw new Error('flow definition: optionsFrom must be a string (FM-6)')
    }
    field.optionsFrom = body.optionsFrom
  }
  if (body.valueFrom !== undefined) {
    if (typeof body.valueFrom !== 'string') {
      throw new Error('flow definition: valueFrom must be a string (FM-6)')
    }
    field.valueFrom = body.valueFrom
  }
  return field
}

/** Read the optional sections of a v2 step (FM-1). */
function readSections(body: unknown): readonly Section[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body)) throw new Error('flow definition: sections must be an array')
  return body.map(readSection)
}

/** Read one section: a key, its fields, and the optional collapsed setting (FM-1). */
function readSection(body: unknown): Section {
  if (!isRecord(body)) throw new Error('flow definition: a section is not an object')
  if (typeof body.key !== 'string') throw new Error('flow definition: a section has no key')
  if (!Array.isArray(body.fields)) {
    throw new Error('flow definition: a section has no fields (FM-1)')
  }
  const section: { key: string; fields: readonly Field[]; collapsed?: boolean } = {
    key: body.key,
    fields: body.fields.map(readV2Field),
  }
  if (body.collapsed !== undefined) {
    if (typeof body.collapsed !== 'boolean') {
      throw new Error('flow definition: collapsed must be a boolean (FM-1)')
    }
    section.collapsed = body.collapsed
  }
  return section
}

/**
 * Read the optional visible or editable field keys of a v2 step (FM-3). Every
 * key must name a field the step has, flat or in a section.
 */
function readFieldKeys(
  body: unknown,
  name: string,
  known: ReadonlySet<string>
): readonly string[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body) || body.some((key) => typeof key !== 'string')) {
    throw new Error(`flow definition: ${name} must be an array of field keys (FM-3)`)
  }
  for (const key of body) {
    if (!known.has(key)) {
      throw new Error(
        `flow definition: ${name} names a field the step does not have: ${key} (FM-3)`
      )
    }
  }
  return body as string[]
}

/**
 * Read the optional rules of a v2 step (FM-2, FM-5). Every target names a
 * field key, or a section key prefixed with `section:`.
 */
function readRules(
  body: unknown,
  fieldKeys: ReadonlySet<string>,
  sectionKeys: ReadonlySet<string>
): readonly Rule[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body)) throw new Error('flow definition: rules must be an array')
  return body.map((rule) => readRule(rule, fieldKeys, sectionKeys))
}

/** Read one rule: a when condition, one of the six effects, and its targets (FM-2, FM-5). */
function readRule(
  body: unknown,
  fieldKeys: ReadonlySet<string>,
  sectionKeys: ReadonlySet<string>
): Rule {
  if (!isRecord(body)) throw new Error('flow definition: a rule is not an object')
  if (body.when === undefined) throw new Error('flow definition: a rule has no when (FM-2)')
  if (!RULE_EFFECTS.includes(body.effect as RuleEffect)) {
    throw new Error(`flow definition: ${String(body.effect)} is not a rule effect (FM-2)`)
  }
  if (body.targets === undefined) throw new Error('flow definition: a rule has no targets (FM-2)')
  if (!Array.isArray(body.targets) || body.targets.some((target) => typeof target !== 'string')) {
    throw new Error('flow definition: rule targets must be an array of strings (FM-2)')
  }
  for (const target of body.targets) {
    const sectionTarget = target.startsWith('section:')
      ? sectionKeys.has(target.slice('section:'.length))
      : false
    if (!fieldKeys.has(target) && !sectionTarget) {
      throw new Error(
        `flow definition: a rule targets a field or section the step does not have: ${target} (FM-2)`
      )
    }
  }
  return {
    when: body.when as JsonValue,
    effect: body.effect as RuleEffect,
    targets: body.targets as string[],
  }
}

/** Read the optional option list of a choice control (FM-1). */
function readOptions(body: unknown): readonly string[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body) || body.some((option) => typeof option !== 'string')) {
    throw new Error('flow definition: options must be an array of strings')
  }
  return body as string[]
}

/**
 * Refuse a field key that shadows the reserved `context` root (FM-2). A rule
 * reads the step and the user from `context`, so a field of that key would
 * make the root ambiguous; the parser refuses it in v1 and v2 alike.
 */
function refuseReservedKey(key: string): void {
  if (key === CONTEXT_KEY) {
    throw new Error(`flow definition: ${CONTEXT_KEY} is a reserved field key (FM-2)`)
  }
}

/** Read the optional outcomes of a step (WF-2). */
function readOutcomes(body: unknown): readonly string[] | undefined {
  if (body === undefined) return undefined
  if (!Array.isArray(body) || body.some((name) => typeof name !== 'string')) {
    throw new Error('flow definition: outcomes must be an array of strings')
  }
  return body as string[]
}

/** The canonical value of a definition: the fixed key order of the flow format. */
function canonicalDefinition(definition: FlowDefinition): JsonValue {
  const canonical: Record<string, JsonValue> = { schemaVersion: definition.schemaVersion }
  if (definition.anonymous !== undefined) canonical.anonymous = definition.anonymous
  canonical.steps = definition.steps.map(canonicalStep)
  return canonical
}

/**
 * The canonical value of one step: key, targets, then the optional flat
 * fields, sections, visible and editable keys, outcomes, skip condition and
 * rules.
 */
function canonicalStep(step: FlowStep): JsonValue {
  const canonical: Record<string, JsonValue> = {
    key: step.key,
    targets: step.targets.map((target) => ({ ...target })),
  }
  if (step.fields !== undefined) canonical.fields = step.fields.map(canonicalField)
  if (step.sections !== undefined) canonical.sections = step.sections.map(canonicalSection)
  if (step.visible !== undefined) canonical.visible = [...step.visible]
  if (step.editable !== undefined) canonical.editable = [...step.editable]
  if (step.outcomes !== undefined) canonical.outcomes = [...step.outcomes]
  if (step.skipWhen !== undefined) canonical.skipWhen = canonicalJson(step.skipWhen)
  if (step.rules !== undefined) canonical.rules = step.rules.map(canonicalRule)
  return canonical
}

/** The canonical value of one section: key, fields, then the optional collapsed setting (FM-1). */
function canonicalSection(section: Section): JsonValue {
  const canonical: Record<string, JsonValue> = {
    key: section.key,
    fields: section.fields.map(canonicalField),
  }
  if (section.collapsed !== undefined) canonical.collapsed = section.collapsed
  return canonical
}

/**
 * The canonical value of one field: key, control, then the optional label,
 * options, required, default, optionsFrom and valueFrom (FM-1, FM-6).
 */
function canonicalField(field: Field): JsonValue {
  const canonical: Record<string, JsonValue> = {
    key: field.key,
    control: field.control,
  }
  if (field.label !== undefined) canonical.label = field.label
  if (field.options !== undefined) canonical.options = [...field.options]
  if (field.required !== undefined) canonical.required = field.required
  if (field.default !== undefined) canonical.default = canonicalJson(field.default)
  if (field.optionsFrom !== undefined) canonical.optionsFrom = field.optionsFrom
  if (field.valueFrom !== undefined) canonical.valueFrom = field.valueFrom
  return canonical
}

/** The canonical value of one rule: when, effect, then targets (FM-2, FM-5). */
function canonicalRule(rule: Rule): JsonValue {
  return {
    when: canonicalJson(rule.when),
    effect: rule.effect,
    targets: [...rule.targets],
  }
}

/** The canonical value of a JSON value: the same value with sorted object keys. */
function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (isRecord(value)) {
    const sorted: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalJson(value[key])
    return sorted
  }
  return value
}

/** A JSON object: not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
