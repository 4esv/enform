// Issue #224, #264, DF-1, DF-4, DF-5, FM-1, FM-2, FM-3, FM-5, ID-3, WF-5,
// SE-3, SE-4, AS-3, I12, ADR 0009, ADR 0012: the builder. It loads the draft
// of one flow, edits the v2 definition as a form and writes it back through
// the public API client. It edits the flow's settings (anonymous access, the
// undo period, the final step), each step's key, targets, outcomes, timers,
// takeover, escalation, sections, fields, visible and editable lists, skip
// condition and rules in place; it saves through `writeDraft` and publishes
// through `publishFlow`. The engine still decides whether the change is
// allowed, whether the definition is valid and what a publication records
// (A9, DF-5); the builder only shows the server's answer.
//
// The model keeps every part of the definition it does not edit (a field
// default, a connector read, a rule it cannot draw) exactly as it read it, so
// a save never drops what the CLI or another builder wrote (DF-4, I9).
//
// Every step and field is plain DOM (ADR 0009). The grant controls post one
// `config.grant.changed@1` operation per checked target and outcome through
// `appendOperation`, so the holder of the step can choose the outcomes the
// form offers (AC-4). A grant operation keeps the ID the client chose (I1), so
// posting the same pair twice appends nothing the second time.

import {
  appendOperation,
  type Grant,
  listFlows,
  type Operation,
  publishFlow,
  RequestRefused,
  readDraft,
  readFlowGrants,
  writeDraft,
} from '../client/client.js'

/** The event type of a grant change (AC-2, I14). */
const GRANT_CHANGE_TYPE = 'config.grant.changed@1'

/**
 * The sixteen FM-1 controls that the builder offers, in the schema's order
 * (FM-1). The builder states the list because I12 keeps it on the public API
 * and the generated client, which names no control set; the integration test
 * exercises a non-default control through the real form.
 */
const BUILDER_CONTROLS = [
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

/** One of the sixteen FM-1 controls the builder edits (FM-1). */
type BuilderControl = (typeof BUILDER_CONTROLS)[number]

/** The choice controls whose option list the builder edits (FM-1). */
const CHOICE_CONTROLS: ReadonlySet<BuilderControl> = new Set(['select', 'multi-select', 'radio'])

/** The takeover settings of a step (AS-3, S10); the empty string means absent. */
const TAKEOVERS = ['', 'always', 'after-idle', 'never'] as const
type Takeover = (typeof TAKEOVERS)[number]

/** The six effects of a rule (FM-2). */
const RULE_EFFECTS = ['show', 'hide', 'collapse', 'require', 'lock', 'skip'] as const
export type RuleEffect = (typeof RULE_EFFECTS)[number]

/** The comparisons the condition builder draws (FM-5). */
const COMPARE_OPS = ['==', '!=', '<', '<=', '>', '>=', 'in'] as const
export type CompareOp = (typeof COMPARE_OPS)[number]

/** A literal on the right of a comparison; `in` takes a list. */
export type Literal = string | number | boolean | readonly (string | number | boolean)[]

/**
 * One condition as the builder draws it (FM-2, FM-5, ADR 0008): a comparison
 * of one value with a literal, an all-of or any-of group, a negation, or the
 * JSON text of a tree the builder cannot draw, kept as it was read.
 */
export type Condition =
  | { readonly kind: 'compare'; op: CompareOp; left: string; right: Literal }
  | { readonly kind: 'group'; op: 'and' | 'or'; items: Condition[] }
  | { readonly kind: 'not'; item: Condition }
  | { readonly kind: 'json'; text: string }

/** One field the builder edits in place. */
export type BuilderField = {
  /** The field as it was read, so the parts the builder does not edit are kept (DF-4). */
  raw?: Record<string, unknown>
  key: string
  label: string
  control: BuilderControl
  options: string
  required: boolean
  /** The key of the section the field belongs to; empty for a flat field (FM-1). */
  section: string
}

/** One named group of fields of a step (FM-1). */
export type BuilderSection = {
  key: string
  collapsed: boolean
}

/** One rule of a step (FM-2): a condition, an effect and the comma-separated targets. */
export type BuilderRule = {
  when: Condition
  effect: RuleEffect
  targets: string
}

/** One step the builder edits in place. */
export type BuilderStep = {
  /** The step as it was read, so the parts the builder does not edit are kept (DF-4). */
  raw?: Record<string, unknown>
  key: string
  targets: string[]
  outcomes: string
  /** The interval between two reminders in minutes, as typed (SE-3, S12). */
  reminderMinutes: string
  /** The deadline from the task's start in minutes, as typed (SE-4, S12). */
  deadlineMinutes: string
  /** When an assignee may take over a claimed task (AS-3, S10). */
  takeover: Takeover
  /** The idle period before an after-idle takeover, in minutes, as typed (AS-3). */
  idleMinutes: string
  /** The comma-separated targets the escalation adds at the deadline (SE-4, S12). */
  escalationTargets: string
  /** The comma-separated keys the step shows; empty means every field (FM-3). */
  visible: string
  /** The comma-separated keys the actor may edit; empty means every field of the step (FM-3). */
  editable: string
  fields: BuilderField[]
  sections: BuilderSection[]
  /** The condition that skips the step (WF-1, S05), or undefined for none. */
  skipWhen: Condition | undefined
  rules: BuilderRule[]
}

/** The whole definition as the builder edits it (DF-1). */
export type BuilderModel = {
  /** The definition as it was read, so the parts the builder does not edit are kept (DF-4). */
  raw?: Record<string, unknown>
  /** Whether the form is open without a sign-in (ID-3). */
  anonymous: boolean
  /** The undo period in hours, as typed (WF-5); empty means the server default. */
  undoHours: string
  /** The key of the step after which the flow is final (WF-5); empty means none. */
  finalStep: string
  steps: BuilderStep[]
}

export interface BuilderOptions {
  /** The element that receives the builder. */
  readonly root: HTMLElement
  readonly slug: string
  /** The signed-in principal; a `starter` target grants reach it. */
  readonly actor: string
  readonly clock: () => number
  /** The operation ID source for the builder's own operations. */
  readonly ids: () => string
}

/** The builder's state between renders. */
type BuilderState = {
  readonly slug: string
  readonly actor: string
  readonly root: HTMLElement
  readonly clock: () => number
  readonly ids: () => string
  title: string | undefined
  draftVersion: number
  model: BuilderModel
  /**
   * The principals that hold `instance.start` on the flow (#232). A `starter`
   * target grants its outcome to them; the builder actor is only the fallback
   * when the flow names none.
   */
  starters: string[]
  /** The checked state of one step/target/outcome pair; absent means checked. */
  readonly grants: Map<string, boolean>
}

/**
 * The grant operation IDs, keyed by the grant they record. A retry of the same
 * pair posts the same ID, so the server appends it once (I1). The map lives for
 * the page's lifetime, and a reload starts a new builder session.
 */
const grantIds = new Map<string, string>()

/** Mount the builder for one flow. */
export async function mountBuilder(options: BuilderOptions): Promise<void> {
  const [draft, flows, grants] = await Promise.all([
    readDraft(options.slug),
    listFlows(),
    readFlowGrants(options.slug),
  ])
  const summary = flows.find((flow) => flow.slug === options.slug)
  const state: BuilderState = {
    slug: options.slug,
    actor: options.actor,
    root: options.root,
    clock: options.clock,
    ids: options.ids,
    title: summary?.title,
    draftVersion: draft.version,
    model: readModel(draft.definition),
    starters: startersOf(grants, options.slug),
    grants: new Map(),
  }
  render(state)
}

/** Render the whole builder from its state. */
function render(state: BuilderState): void {
  const root = state.root
  root.replaceChildren()

  const heading = document.createElement('h1')
  heading.textContent = state.title ?? state.slug
  heading.dataset.builderTitle = ''
  root.appendChild(heading)
  const slug = document.createElement('p')
  slug.className = 'builder-slug'
  slug.textContent = state.slug
  root.appendChild(slug)

  const controls = document.createElement('div')
  controls.className = 'builder-controls'
  const addStep = document.createElement('button')
  addStep.type = 'button'
  addStep.textContent = 'Add step'
  addStep.dataset.addStep = ''
  addStep.addEventListener('click', () => {
    const steps = state.model.steps
    if (steps.length > 0) {
      const last = steps[steps.length - 1]
      // The last step becomes a middle step, so its default outcome is the
      // approval that the next step receives (DF-4, FM-1).
      if (last !== undefined && (last.outcomes.trim() === '' || last.outcomes.trim() === 'submit'))
        last.outcomes = 'approve'
    }
    steps.push({ ...defaultStep(steps.length + 1), key: `step${steps.length + 1}` })
    render(state)
  })
  controls.appendChild(addStep)

  const removeStep = document.createElement('button')
  removeStep.type = 'button'
  removeStep.textContent = 'Remove last step'
  removeStep.dataset.removeStep = ''
  removeStep.disabled = state.model.steps.length <= 1
  removeStep.addEventListener('click', () => {
    if (state.model.steps.length <= 1) return
    state.model.steps.pop()
    render(state)
  })
  controls.appendChild(removeStep)

  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = 'Save draft'
  save.dataset.save = ''
  save.addEventListener('click', () => {
    void saveDraft(state)
  })
  controls.appendChild(save)

  const publish = document.createElement('button')
  publish.type = 'button'
  publish.textContent = 'Publish'
  publish.dataset.publish = ''
  publish.addEventListener('click', () => {
    void publishDraft(state)
  })
  controls.appendChild(publish)
  root.appendChild(controls)

  const status = document.createElement('p')
  status.className = 'status builder-status'
  status.dataset.builderStatus = ''
  root.appendChild(status)

  const published = document.createElement('p')
  published.className = 'published'
  published.dataset.published = ''
  root.appendChild(published)

  root.appendChild(renderSettings(state))
  root.appendChild(renderStarters(state))

  const steps = document.createElement('div')
  steps.id = 'builder-steps'
  state.model.steps.forEach((step, index) => {
    steps.appendChild(renderStep(state, step, index))
  })
  root.appendChild(steps)
}

/**
 * Render the flow's settings (ID-3, WF-5): anonymous access with its visible
 * label, the undo period and the final step.
 */
function renderSettings(state: BuilderState): HTMLElement {
  const model = state.model
  const box = document.createElement('section')
  box.className = 'builder-settings'
  box.dataset.settings = ''
  const heading = document.createElement('h2')
  heading.textContent = 'Settings'
  box.appendChild(heading)

  const anonymousLabel = document.createElement('label')
  anonymousLabel.className = 'inline'
  const anonymous = document.createElement('input')
  anonymous.type = 'checkbox'
  anonymous.checked = model.anonymous
  anonymous.dataset.anonymous = ''
  anonymous.dataset.field = 'settings/anonymous'
  const anonymousText = document.createElement('span')
  anonymousText.dataset.anonymousLabel = ''
  anonymousText.textContent = anonymousLabelOf(model.anonymous)
  anonymous.addEventListener('change', () => {
    model.anonymous = anonymous.checked
    anonymousText.textContent = anonymousLabelOf(model.anonymous)
  })
  anonymousLabel.append(anonymous, anonymousText)
  box.appendChild(anonymousLabel)

  const undo = minuteRow('Undo period (hours, empty for the default)', model.undoHours, 'undoHours')
  undo.input.dataset.field = 'settings/undoHours'
  undo.input.addEventListener('input', () => {
    model.undoHours = undo.input.value
  })
  box.appendChild(undo.row)

  const finalStep = selectRow('Final step (no undo after it completes)')
  finalStep.input.dataset.finalStep = ''
  finalStep.input.dataset.field = 'settings/finalStep'
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'none'
  finalStep.input.appendChild(none)
  for (const step of model.steps) {
    const option = document.createElement('option')
    option.value = step.key
    option.textContent = step.key
    finalStep.input.appendChild(option)
  }
  finalStep.input.value = model.steps.some((step) => step.key === model.finalStep)
    ? model.finalStep
    : ''
  finalStep.input.addEventListener('change', () => {
    model.finalStep = finalStep.input.value
  })
  box.appendChild(finalStep.row)
  return box
}

/** The visible label of the anonymous setting (ID-3). */
function anonymousLabelOf(anonymous: boolean): string {
  return anonymous
    ? 'Anonymous access: on. Anyone with the link can start without signing in.'
    : 'Anonymous access: off. A starter signs in first.'
}

/** Render one step's key, targets, outcomes, settings, sections, fields and grant controls. */
function renderStep(state: BuilderState, step: BuilderStep, index: number): HTMLElement {
  const section = document.createElement('section')
  section.className = 'builder-step'
  section.dataset.stepIndex = String(index)
  const at = (what: string): string => `step:${step.key}/${what}`

  const heading = document.createElement('h2')
  heading.textContent = `Step ${index + 1}`
  section.appendChild(heading)

  const key = textRow('Key')
  key.input.value = step.key
  key.input.dataset.stepKey = ''
  key.input.dataset.field = at('key')
  key.input.addEventListener('input', () => {
    step.key = key.input.value
  })
  section.appendChild(key.row)

  const targets = document.createElement('div')
  targets.className = 'targets'
  const targetHeading = document.createElement('h3')
  targetHeading.textContent = 'Targets'
  targets.appendChild(targetHeading)
  for (let target = 0; target < 2; target += 1) {
    const input = textRow(target === 0 ? 'Target' : 'Second target (optional)')
    input.input.value = step.targets[target] ?? ''
    input.input.dataset.target = String(target)
    input.input.dataset.field = at(`target:${target}`)
    input.input.placeholder = 'starter, user:<id>, group:<id>, team:<name> or field:<key>'
    input.input.addEventListener('input', () => {
      const value = input.input.value.trim()
      if (value === '') {
        step.targets.splice(target, 1)
        return
      }
      while (step.targets.length < target) step.targets.push('')
      step.targets[target] = value
    })
    input.input.addEventListener('change', () => render(state))
    targets.appendChild(input.row)
  }
  section.appendChild(targets)

  const outcomes = textRow('Outcomes (comma-separated)')
  outcomes.input.value = step.outcomes
  outcomes.input.dataset.outcomes = ''
  outcomes.input.dataset.field = at('outcomes')
  outcomes.input.addEventListener('input', () => {
    step.outcomes = outcomes.input.value
  })
  outcomes.input.addEventListener('change', () => render(state))
  section.appendChild(outcomes.row)

  section.appendChild(renderStepSettings(step, at))
  section.appendChild(renderSections(state, step, at))

  const fields = document.createElement('div')
  fields.className = 'builder-fields'
  const fieldHeading = document.createElement('h3')
  fieldHeading.textContent = 'Fields'
  fields.appendChild(fieldHeading)
  step.fields.forEach((field, fieldIndex) => {
    fields.appendChild(renderField(state, step, field, fieldIndex, at))
  })
  const addField = document.createElement('button')
  addField.type = 'button'
  addField.textContent = 'Add field'
  addField.dataset.addField = String(index)
  addField.addEventListener('click', () => {
    step.fields.push({
      key: `field${step.fields.length + 1}`,
      label: '',
      control: 'text',
      options: '',
      required: false,
      section: step.sections[0]?.key ?? '',
    })
    render(state)
  })
  fields.appendChild(addField)
  section.appendChild(fields)

  section.appendChild(renderGrants(state, step, index))
  return section
}

/**
 * Render one step's settings (SE-3, SE-4, AS-3, FM-3, S10, S12): the timers,
 * the takeover, the escalation targets, and the visible and editable lists.
 */
function renderStepSettings(step: BuilderStep, at: (what: string) => string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'step-settings'
  const heading = document.createElement('h3')
  heading.textContent = 'Step settings'
  box.appendChild(heading)

  // The task's timers (SE-3, SE-4, S12): the reminder interval and the
  // deadline from the task's start, both in minutes. An empty input means the
  // step sets no reminder or no deadline, and the engine schedules nothing.
  const reminders = minuteRow(
    'Reminder every (minutes, empty for none)',
    step.reminderMinutes,
    'reminderMinutes'
  )
  reminders.input.dataset.field = at('reminderMinutes')
  reminders.input.addEventListener('input', () => {
    step.reminderMinutes = reminders.input.value
  })
  box.appendChild(reminders.row)

  const deadline = minuteRow(
    'Deadline (minutes, empty for none)',
    step.deadlineMinutes,
    'deadlineMinutes'
  )
  deadline.input.dataset.field = at('deadlineMinutes')
  deadline.input.addEventListener('input', () => {
    step.deadlineMinutes = deadline.input.value
  })
  box.appendChild(deadline.row)

  const escalation = textRow('Escalation targets at the deadline (comma-separated, empty for none)')
  escalation.input.value = step.escalationTargets
  escalation.input.dataset.escalationTargets = ''
  escalation.input.dataset.field = at('escalationTargets')
  escalation.input.addEventListener('input', () => {
    step.escalationTargets = escalation.input.value
  })
  box.appendChild(escalation.row)

  const takeover = selectRow('Takeover of a claimed task')
  takeover.input.dataset.takeover = ''
  takeover.input.dataset.field = at('takeover')
  const takeoverLabels: Record<Takeover, string> = {
    '': 'never (default)',
    always: 'always, at once',
    'after-idle': 'after the holder has been idle',
    never: 'never',
  }
  for (const value of TAKEOVERS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = takeoverLabels[value]
    takeover.input.appendChild(option)
  }
  takeover.input.value = step.takeover
  takeover.input.addEventListener('change', () => {
    step.takeover = isTakeover(takeover.input.value) ? takeover.input.value : ''
    idle.row.hidden = step.takeover !== 'after-idle'
  })
  box.appendChild(takeover.row)

  const idle = minuteRow(
    'Idle period before a takeover (minutes, empty for 60)',
    step.idleMinutes,
    'idleMinutes'
  )
  idle.input.dataset.field = at('idleMinutes')
  idle.row.hidden = step.takeover !== 'after-idle'
  idle.input.addEventListener('input', () => {
    step.idleMinutes = idle.input.value
  })
  box.appendChild(idle.row)

  const visible = textRow('Visible fields (comma-separated keys, empty for all)')
  visible.input.value = step.visible
  visible.input.dataset.visible = ''
  visible.input.dataset.field = at('visible')
  visible.input.addEventListener('input', () => {
    step.visible = visible.input.value
  })
  box.appendChild(visible.row)

  const editable = textRow('Editable fields (comma-separated keys, empty for all of this step)')
  editable.input.value = step.editable
  editable.input.dataset.editable = ''
  editable.input.dataset.field = at('editable')
  editable.input.addEventListener('input', () => {
    step.editable = editable.input.value
  })
  box.appendChild(editable.row)
  return box
}

/**
 * Render one step's sections (FM-1): each key and collapsed default, a
 * control that removes it, and one that adds a section. A step shows either
 * flat fields or sections, so the first section takes every field.
 */
function renderSections(
  state: BuilderState,
  step: BuilderStep,
  at: (what: string) => string
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'builder-sections'
  const heading = document.createElement('h3')
  heading.textContent = 'Sections'
  box.appendChild(heading)
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent =
    step.sections.length === 0
      ? 'No sections: the step shows its fields as one list.'
      : 'Each field belongs to one section; a collapsed section opens on demand.'
  box.appendChild(hint)
  step.sections.forEach((section, index) => {
    const row = document.createElement('div')
    row.className = 'builder-section'
    row.dataset.sectionIndex = String(index)
    const key = textRow('Section key')
    key.input.value = section.key
    key.input.dataset.sectionKey = ''
    key.input.dataset.field = at(`section:${section.key}/key`)
    key.input.addEventListener('input', () => {
      const previous = section.key
      section.key = key.input.value
      for (const field of step.fields) if (field.section === previous) field.section = section.key
    })
    key.input.addEventListener('change', () => render(state))
    row.appendChild(key.row)
    const collapsedLabel = document.createElement('label')
    collapsedLabel.className = 'inline'
    const collapsed = document.createElement('input')
    collapsed.type = 'checkbox'
    collapsed.checked = section.collapsed
    collapsed.dataset.sectionCollapsed = ''
    collapsed.dataset.field = at(`section:${section.key}/collapsed`)
    collapsed.addEventListener('change', () => {
      section.collapsed = collapsed.checked
    })
    collapsedLabel.append(collapsed, 'Collapsed by default')
    row.appendChild(collapsedLabel)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove section'
    remove.dataset.removeSection = String(index)
    remove.addEventListener('click', () => {
      step.sections.splice(index, 1)
      const first = step.sections[0]?.key ?? ''
      for (const field of step.fields) if (field.section === section.key) field.section = first
      render(state)
    })
    row.appendChild(remove)
    box.appendChild(row)
  })
  const add = document.createElement('button')
  add.type = 'button'
  add.textContent = 'Add section'
  add.dataset.addSection = ''
  add.addEventListener('click', () => {
    const key = `section${step.sections.length + 1}`
    step.sections.push({ key, collapsed: false })
    if (step.sections.length === 1) for (const field of step.fields) field.section = key
    render(state)
  })
  box.appendChild(add)
  return box
}

/** Render one field in place: its key, label, control, options, section and required mark. */
function renderField(
  state: BuilderState,
  step: BuilderStep,
  field: BuilderField,
  index: number,
  at: (what: string) => string
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'builder-field'
  row.dataset.fieldIndex = String(index)
  const where = (what: string): string => at(`field:${field.key}/${what}`)

  const key = textRow('Field key')
  key.input.value = field.key
  key.input.dataset.fieldKey = ''
  key.input.dataset.field = where('key')
  key.input.addEventListener('input', () => {
    field.key = key.input.value
  })
  row.appendChild(key.row)

  const label = textRow('Label')
  label.input.value = field.label
  label.input.dataset.fieldLabel = ''
  label.input.dataset.field = where('label')
  label.input.addEventListener('input', () => {
    field.label = label.input.value
  })
  row.appendChild(label.row)

  const control = selectRow('Control')
  for (const kind of BUILDER_CONTROLS) {
    const option = document.createElement('option')
    option.value = kind
    option.textContent = kind
    control.input.appendChild(option)
  }
  control.input.value = field.control
  control.input.dataset.fieldControl = ''
  control.input.dataset.field = where('control')
  control.input.addEventListener('change', () => {
    field.control = isBuilderControl(control.input.value) ? control.input.value : 'text'
    render(state)
  })
  row.appendChild(control.row)

  if (CHOICE_CONTROLS.has(field.control)) {
    const options = textRow('Options (comma-separated)')
    options.input.value = field.options
    options.input.dataset.fieldOptions = ''
    options.input.dataset.field = where('options')
    options.input.addEventListener('input', () => {
      field.options = options.input.value
    })
    row.appendChild(options.row)
  }

  if (step.sections.length > 0) {
    const section = selectRow('Section')
    section.input.dataset.fieldSection = ''
    section.input.dataset.field = where('section')
    for (const entry of step.sections) {
      const option = document.createElement('option')
      option.value = entry.key
      option.textContent = entry.key
      section.input.appendChild(option)
    }
    section.input.value = step.sections.some((entry) => entry.key === field.section)
      ? field.section
      : (step.sections[0]?.key ?? '')
    section.input.addEventListener('change', () => {
      field.section = section.input.value
    })
    row.appendChild(section.row)
  }

  const requiredLabel = document.createElement('label')
  requiredLabel.className = 'inline'
  const required = document.createElement('input')
  required.type = 'checkbox'
  required.checked = field.required
  required.dataset.fieldRequired = ''
  required.dataset.field = where('required')
  required.addEventListener('change', () => {
    field.required = required.checked
  })
  requiredLabel.append(required, 'Required')
  row.appendChild(requiredLabel)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = 'Remove field'
  remove.dataset.removeField = String(index)
  remove.addEventListener('click', () => {
    step.fields.splice(index, 1)
    render(state)
  })
  row.appendChild(remove)

  return row
}

/**
 * Render the flow-level starters (#232): who may start this flow, the input
 * that adds one, and the link the requester opens. Adding a starter appends
 * two grants through the write path: `instance.start` on the flow and the
 * first step's first outcome on the first step. The engine authorizes both
 * from the administrator's `org.grants` on the organization or `flow.grant`
 * on the flow.
 */
function renderStarters(state: BuilderState): HTMLElement {
  const box = document.createElement('section')
  box.className = 'builder-starters'
  box.dataset.starters = ''
  const heading = document.createElement('h2')
  heading.textContent = 'Starters'
  box.appendChild(heading)

  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.append('A starter opens ')
  const link = document.createElement('a')
  link.href = `/?flow=${encodeURIComponent(state.slug)}`
  link.dataset.starterLink = ''
  link.textContent = `/?flow=${state.slug}`
  hint.append(
    link,
    ", fills the first step and submits. Adding a starter grants instance.start on this flow and the first step's first outcome."
  )
  box.appendChild(hint)

  const list = document.createElement('ul')
  list.className = 'starter-list'
  list.dataset.starterList = ''
  if (state.starters.length === 0) {
    const empty = document.createElement('li')
    empty.dataset.startersEmpty = ''
    empty.textContent =
      'No starters yet. The builder actor is the default starter in the outcome grid.'
    list.appendChild(empty)
  } else {
    for (const principal of state.starters) {
      const item = document.createElement('li')
      item.dataset.starterPrincipal = principal
      item.textContent = principal
      list.appendChild(item)
    }
  }
  box.appendChild(list)

  const row = textRow('Principal (user:<id>, team:<name> or an id)')
  row.input.dataset.starterInput = ''
  row.input.dataset.field = 'starters/add'
  row.input.placeholder = 'user:<id> or team:<name>'
  box.appendChild(row.row)

  const add = document.createElement('button')
  add.type = 'button'
  add.textContent = 'Add starter'
  add.dataset.addStarter = ''
  add.addEventListener('click', () => {
    void addStarter(state, row.input)
  })
  box.appendChild(add)

  const confirmation = document.createElement('p')
  confirmation.className = 'status starter-status'
  confirmation.dataset.starterStatus = ''
  box.appendChild(confirmation)

  // The engine records grants as append-only configuration and has no revoke
  // operation (#232), so the section stays add-only rather than inventing one.
  const gap = document.createElement('p')
  gap.className = 'hint'
  gap.dataset.starterGap = ''
  gap.textContent =
    'Removing a starter is not offered yet: the engine has no grant-revoke operation.'
  box.appendChild(gap)
  return box
}

/**
 * Render the grant grid of one step: one checkbox per target and outcome, and
 * a control that posts the checked pairs. The default is checked, so a fresh
 * flow grants its own outcomes to its targets and is usable at once; the
 * selection stays visible and editable. A `starter` target names every
 * configured starter, and the builder actor only when the flow names none
 * (#232).
 */
function renderGrants(state: BuilderState, step: BuilderStep, index: number): HTMLElement {
  const box = document.createElement('div')
  box.className = 'grants'
  const heading = document.createElement('h3')
  heading.textContent = 'Grant outcomes'
  box.appendChild(heading)
  const outcomes = splitList(step.outcomes)
  const targets = step.targets.filter((target) => target !== '')
  if (outcomes.length === 0 || targets.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'Add a target and an outcome to grant it.'
    box.appendChild(empty)
    return box
  }
  const grid = document.createElement('div')
  grid.className = 'grant-grid'
  for (const outcome of outcomes) {
    for (const target of targets) {
      // A `starter` target is dynamic: each grant names a configured starter,
      // because that is who the engine resolves `starter` to in an instance
      // that person starts. A user target is its immutable ID (ID-4). A field
      // or manager-of target resolves per instance, so it grants nothing here.
      for (const principal of principalsOf(state, target)) {
        if (principal === '') continue
        const key = grantKey(state.slug, step.key, principal, outcome)
        const label = document.createElement('label')
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.dataset.grantCheck = ''
        checkbox.dataset.grantStep = step.key
        checkbox.dataset.grantTarget = target
        checkbox.dataset.grantPrincipal = principal
        checkbox.dataset.grantOutcome = outcome
        checkbox.checked = state.grants.get(key) ?? true
        checkbox.addEventListener('change', () => {
          state.grants.set(key, checkbox.checked)
        })
        label.append(checkbox, `${outcome} to ${targetLabel(state, target, principal)}`)
        grid.appendChild(label)
      }
    }
  }
  box.appendChild(grid)
  const grant = document.createElement('button')
  grant.type = 'button'
  grant.textContent = 'Grant outcomes'
  grant.dataset.grant = String(index)
  grant.addEventListener('click', () => {
    void grantOutcomes(state, box)
  })
  box.appendChild(grant)
  return box
}

/**
 * Add one starter through the write path (#232). The principal is normalized
 * like a target (ID-4, #252): `user:<id>` and a bare id are the same user, and
 * `group:<id>` and `team:<name>` keep their kind. The builder appends the two grants the requester
 * needs and re-renders, so the outcome grid names the new starter at once.
 */
async function addStarter(state: BuilderState, input: HTMLInputElement): Promise<void> {
  const confirmation = starterStatusOf(state)
  const principal = principalOfStarter(input.value)
  if (principal === '') {
    confirmation.textContent = 'Enter a user:<id>, group:<id>, team:<name> or an id.'
    return
  }
  const first = state.model.steps[0]
  if (first === undefined) {
    confirmation.textContent = 'Add a first step before adding a starter.'
    return
  }
  const firstOutcome = splitList(first.outcomes)[0] ?? 'submit'
  const operations: Operation[] = [
    {
      id: grantId(starterGrantKey(state.slug, principal)),
      type: GRANT_CHANGE_TYPE,
      at: state.clock(),
      actor: state.actor,
      payload: { principal, scopes: ['instance.start'], resource: `flow:${state.slug}` },
    },
    {
      id: grantId(grantKey(state.slug, first.key, principal, firstOutcome)),
      type: GRANT_CHANGE_TYPE,
      at: state.clock(),
      actor: state.actor,
      payload: {
        principal,
        scopes: [`step.outcome:${firstOutcome}`],
        resource: `flow:${state.slug}/step:${first.key}`,
      },
    },
  ]
  try {
    for (const operation of operations) await appendOperation(operation)
    if (!state.starters.includes(principal)) state.starters.push(principal)
    render(state)
    starterStatusOf(state).textContent =
      `Added ${principal}. They open /?flow=${state.slug} to start.`
  } catch (error: unknown) {
    confirmation.textContent = messageOf(error)
  }
}

/** Write the draft through the API, and show the server's answer (DF-4, I5). */
async function saveDraft(state: BuilderState): Promise<void> {
  const status = statusOf(state)
  const definition = writeDefinition(state.model)
  try {
    const written = await writeDraft({ version: state.draftVersion, definition }, state.slug)
    state.draftVersion = written.version
    status.textContent = `Saved draft version ${written.version}`
  } catch (error: unknown) {
    await showWriteError(state, error, status)
  }
}

/** Publish the draft and show the version and content hash prefix (DF-2, VT-6). */
async function publishDraft(state: BuilderState): Promise<void> {
  const status = statusOf(state)
  try {
    const published = await publishFlow({ version: state.draftVersion }, state.slug)
    status.textContent = 'Published'
    const element = state.root.querySelector<HTMLElement>('[data-published]')
    if (element !== null) {
      element.textContent = `Published version ${published.version}, content ${published.contentHash.slice(0, 8)}`
    }
    // The next draft publishes as the next version, so a second save and
    // publish are based on the version the server now names (I5).
    state.draftVersion = (await readDraft(state.slug)).version
  } catch (error: unknown) {
    await showWriteError(state, error, status)
  }
}

/** Post one grant operation for every checked pair (AC-4, I1, I14). */
async function grantOutcomes(state: BuilderState, host: HTMLElement): Promise<void> {
  const status = statusOf(state)
  const checks = host.querySelectorAll<HTMLInputElement>('[data-grant-check]')
  let granted = 0
  try {
    for (const check of checks) {
      if (!check.checked) continue
      const step = check.dataset.grantStep ?? ''
      const principal = check.dataset.grantPrincipal ?? ''
      const outcome = check.dataset.grantOutcome ?? ''
      if (step === '' || principal === '' || outcome === '') continue
      const operation: Operation = {
        id: grantId(grantKey(state.slug, step, principal, outcome)),
        type: GRANT_CHANGE_TYPE,
        at: state.clock(),
        actor: state.actor,
        payload: {
          principal,
          scopes: [`step.outcome:${outcome}`],
          resource: `flow:${state.slug}/step:${step}`,
        },
      }
      await appendOperation(operation)
      granted += 1
    }
    status.textContent = granted === 1 ? 'Granted 1 outcome' : `Granted ${granted} outcomes`
  } catch (error: unknown) {
    status.textContent = messageOf(error)
  }
}

/** Show a refused write; a stale draft is re-read and the editor shows the new draft (I5). */
async function showWriteError(
  state: BuilderState,
  error: unknown,
  status: HTMLElement
): Promise<void> {
  if (error instanceof RequestRefused && error.status === 409) {
    const fresh = await readDraft(state.slug)
    state.draftVersion = fresh.version
    state.model = readModel(fresh.definition)
    render(state)
    const refreshed = statusOf(state)
    refreshed.textContent = `The draft changed; reloaded version ${fresh.version}. ${error.error}`
    return
  }
  status.textContent = messageOf(error)
}

// The model (DF-1, DF-4, I9): the pure read of a v2 definition into what the
// builder edits, and the pure write back. Both keep what the builder does
// not edit, so `writeDefinition(readModel(definition))` is `definition`.

/** The v2 definition the builder writes (DF-1, DF-4, I9). */
export function writeDefinition(model: BuilderModel): Record<string, unknown> {
  const flow: Record<string, unknown> = { ...(model.raw ?? {}) }
  flow.schemaVersion = 2
  setOrDelete(flow, 'anonymous', model.anonymous ? true : undefined)
  setOrDelete(flow, 'undoHours', positiveMinutes(model.undoHours))
  setOrDelete(flow, 'finalStep', nonEmpty(model.finalStep))
  flow.steps = model.steps.map(writeStep)
  return flow
}

function writeStep(step: BuilderStep): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(step.raw ?? {}) }
  body.key = step.key
  body.targets = step.targets
    .map((target) => target.trim())
    .filter((target) => target !== '')
    .map(targetOf)
  const fields = step.fields.map(writeField)
  if (step.sections.length > 0) {
    // A step shows either flat fields or sections (FM-1): a field whose
    // section is gone joins the first one.
    delete body.fields
    const first = step.sections[0]?.key ?? ''
    body.sections = step.sections.map((section) => ({
      key: section.key,
      ...(section.collapsed ? { collapsed: true } : {}),
      fields: step.fields
        .map((field, index) => ({ field, written: fields[index] }))
        .filter(
          ({ field }) =>
            field.section === section.key ||
            (section.key === first && !step.sections.some((entry) => entry.key === field.section))
        )
        .map(({ written }) => written),
    }))
  } else {
    delete body.sections
    setOrDelete(body, 'fields', fields.length === 0 ? undefined : fields)
  }
  const keys = step.fields.map((field) => field.key)
  setOrDelete(body, 'visible', listOrUndefined(step.visible))
  // The step's assignees edit the fields the builder adds (FM-3); without
  // this list the engine makes no field editable and the form is read-only.
  setOrDelete(
    body,
    'editable',
    listOrUndefined(step.editable) ?? (keys.length === 0 ? undefined : keys)
  )
  setOrDelete(body, 'outcomes', listOrUndefined(step.outcomes))
  setOrDelete(body, 'reminderMinutes', positiveMinutes(step.reminderMinutes))
  setOrDelete(body, 'deadlineMinutes', positiveMinutes(step.deadlineMinutes))
  setOrDelete(body, 'takeover', nonEmpty(step.takeover))
  setOrDelete(
    body,
    'idleMinutes',
    step.takeover === 'after-idle' ? positiveMinutes(step.idleMinutes) : undefined
  )
  setOrDelete(body, 'escalationTargets', listOrUndefined(step.escalationTargets)?.map(targetOf))
  setOrDelete(body, 'skipWhen', step.skipWhen === undefined ? undefined : treeOf(step.skipWhen))
  setOrDelete(
    body,
    'rules',
    step.rules.length === 0
      ? undefined
      : step.rules.map((rule) => ({
          when: treeOf(rule.when),
          effect: rule.effect,
          targets: splitList(rule.targets),
        }))
  )
  return body
}

function writeField(field: BuilderField): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(field.raw ?? {}) }
  body.key = field.key
  body.control = field.control
  setOrDelete(body, 'label', nonEmpty(field.label))
  setOrDelete(
    body,
    'options',
    CHOICE_CONTROLS.has(field.control) ? splitList(field.options) : undefined
  )
  setOrDelete(body, 'required', field.required ? true : undefined)
  return body
}

/** Read a v2 definition into the builder's editable model (DF-1, DF-4). */
export function readModel(definition: Record<string, unknown> | undefined): BuilderModel {
  const raw = definition === undefined ? {} : { ...definition }
  const steps = Array.isArray(raw.steps) ? raw.steps : []
  return {
    raw,
    anonymous: raw.anonymous === true,
    undoHours: minutesOf(raw.undoHours),
    finalStep: typeof raw.finalStep === 'string' ? raw.finalStep : '',
    steps:
      steps.length === 0
        ? [defaultStep(1)]
        : steps.map((body, index) => readStep(body, index, steps.length)),
  }
}

function readStep(body: unknown, index: number, total: number): BuilderStep {
  const step = isRecord(body) ? body : {}
  const outcomes = Array.isArray(step.outcomes) ? step.outcomes : []
  const sections: BuilderSection[] = []
  const fields: BuilderField[] = []
  if (Array.isArray(step.sections)) {
    for (const entry of step.sections) {
      if (!isRecord(entry) || typeof entry.key !== 'string') continue
      sections.push({ key: entry.key, collapsed: entry.collapsed === true })
      for (const field of Array.isArray(entry.fields) ? entry.fields : []) {
        const read = readField(field, entry.key)
        if (read !== undefined) fields.push(read)
      }
    }
  }
  for (const field of Array.isArray(step.fields) ? step.fields : []) {
    const read = readField(field, '')
    if (read !== undefined) fields.push(read)
  }
  const rules: BuilderRule[] = []
  for (const rule of Array.isArray(step.rules) ? step.rules : []) {
    if (!isRecord(rule) || !isRuleEffect(rule.effect)) continue
    rules.push({
      when: conditionOf(rule.when),
      effect: rule.effect,
      targets: Array.isArray(rule.targets) ? rule.targets.map(String).join(', ') : '',
    })
  }
  return {
    raw: step,
    key: typeof step.key === 'string' ? step.key : `step${index + 1}`,
    targets: readTargets(step.targets, ['starter']),
    outcomes:
      outcomes.length > 0 ? outcomes.join(', ') : index === total - 1 ? 'submit' : 'approve',
    reminderMinutes: minutesOf(step.reminderMinutes),
    deadlineMinutes: minutesOf(step.deadlineMinutes),
    takeover: isTakeover(step.takeover) ? step.takeover : '',
    idleMinutes: minutesOf(step.idleMinutes),
    escalationTargets: readTargets(step.escalationTargets, []).join(', '),
    visible: Array.isArray(step.visible) ? step.visible.map(String).join(', ') : '',
    editable: Array.isArray(step.editable) ? step.editable.map(String).join(', ') : '',
    fields,
    sections,
    skipWhen: step.skipWhen === undefined ? undefined : conditionOf(step.skipWhen),
    rules,
  }
}

/** The builder's default step, matching the engine's starter definition (DF-1). */
function defaultStep(index: number): BuilderStep {
  return {
    key: index === 1 ? 'start' : `step${index}`,
    targets: ['starter'],
    outcomes: 'submit',
    reminderMinutes: '',
    deadlineMinutes: '',
    takeover: '',
    idleMinutes: '',
    escalationTargets: '',
    visible: '',
    editable: '',
    fields: [],
    sections: [],
    skipWhen: undefined,
    rules: [],
  }
}

function readField(body: unknown, section: string): BuilderField | undefined {
  if (!isRecord(body) || typeof body.key !== 'string') return undefined
  const control = body.control
  return {
    raw: body,
    key: body.key,
    label: typeof body.label === 'string' ? body.label : '',
    control: isBuilderControl(control) ? control : 'text',
    options: Array.isArray(body.options)
      ? body.options.filter((option): option is string => typeof option === 'string').join(', ')
      : '',
    required: body.required === true,
    section,
  }
}

/** Whether a definition names one of the controls the builder offers (FM-1). */
function isBuilderControl(value: unknown): value is BuilderControl {
  return typeof value === 'string' && (BUILDER_CONTROLS as readonly string[]).includes(value)
}

function isTakeover(value: unknown): value is Takeover {
  return typeof value === 'string' && (TAKEOVERS as readonly string[]).includes(value)
}

function isRuleEffect(value: unknown): value is RuleEffect {
  return typeof value === 'string' && (RULE_EFFECTS as readonly string[]).includes(value)
}

function isCompareOp(value: string): value is CompareOp {
  return (COMPARE_OPS as readonly string[]).includes(value)
}

/** The targets of a definition as the builder's text, or the fallback when there are none. */
function readTargets(value: unknown, fallback: readonly string[]): string[] {
  const targets = Array.isArray(value) ? value : []
  const read: string[] = []
  for (const target of targets) {
    if (!isRecord(target)) continue
    if (target.starter !== undefined) read.push('starter')
    else if (typeof target.group === 'string') read.push(`group:${target.group}`)
    else if (typeof target.team === 'string') read.push(`team:${target.team}`)
    else if (typeof target.field === 'string') read.push(`field:${target.field}`)
    else if (typeof target['manager-of'] === 'string')
      read.push(`manager-of:${target['manager-of']}`)
    else if (typeof target.user === 'string') read.push(target.user)
  }
  return read.length === 0 ? [...fallback] : read
}

/**
 * The target a builder input names (AS-1, #252, I12). `group:<id>` and
 * `team:<name>` keep their kind, so the engine resolves the directory group
 * or the team live; `field:<key>` and `manager-of:<who>` are the dynamic
 * targets of AS-1; `user:<id>` and a bare id are the same user (ID-4).
 */
export function targetOf(value: string): Record<string, string> {
  const target = value.trim()
  if (target === 'starter') return { starter: 'starter' }
  const separator = target.indexOf(':')
  if (separator > 0 && separator < target.length - 1) {
    const kind = target.slice(0, separator)
    const name = target.slice(separator + 1).trim()
    if (
      name !== '' &&
      (kind === 'group' ||
        kind === 'team' ||
        kind === 'user' ||
        kind === 'field' ||
        kind === 'manager-of')
    ) {
      return { [kind]: name }
    }
  }
  return { user: target }
}

// The condition builder (FM-2, FM-5, ADR 0008): one JSON Logic tree in, one
// out. A tree the builder cannot draw stays JSON text and is written back as
// it was read.

/** Read a JSON Logic tree into the condition the builder draws, or keep it as JSON. */
export function conditionOf(tree: unknown): Condition {
  const json = (): Condition => ({ kind: 'json', text: JSON.stringify(tree) })
  if (!isRecord(tree)) return json()
  const entries = Object.entries(tree)
  if (entries.length !== 1) return json()
  const [operator, operands] = entries[0] as [string, unknown]
  if (!Array.isArray(operands)) return json()
  if (isCompareOp(operator)) {
    if (operands.length !== 2) return json()
    const [left, right] = operands as [unknown, unknown]
    if (!isRecord(left) || typeof left.var !== 'string' || Object.keys(left).length !== 1)
      return json()
    if (operator === 'in') {
      if (!Array.isArray(right) || !right.every(isScalar)) return json()
      return { kind: 'compare', op: operator, left: left.var, right: [...right] }
    }
    if (!isScalar(right)) return json()
    return { kind: 'compare', op: operator, left: left.var, right }
  }
  if (operator === 'and' || operator === 'or') {
    if (operands.length === 0) return json()
    return { kind: 'group', op: operator, items: operands.map(conditionOf) }
  }
  if (operator === '!' && operands.length === 1) {
    return { kind: 'not', item: conditionOf(operands[0]) }
  }
  return json()
}

/** The JSON Logic tree of a condition (FM-5). JSON text that does not parse is kept as text. */
export function treeOf(condition: Condition): unknown {
  switch (condition.kind) {
    case 'compare':
      return { [condition.op]: [{ var: condition.left }, condition.right] }
    case 'group':
      return { [condition.op]: condition.items.map(treeOf) }
    case 'not':
      return { '!': [treeOf(condition.item)] }
    case 'json':
      try {
        return JSON.parse(condition.text)
      } catch {
        return condition.text
      }
  }
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** The symbol of one comparison as the builder shows it (S05). */
const COMPARE_SYMBOLS: Readonly<Record<CompareOp, string>> = {
  '==': '=',
  '!=': '≠',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  in: 'in',
}

/**
 * A condition in plain words (S05, FM-2): each value by its field label, the
 * reserved context values as Step and User, each comparison by its symbol, a
 * group joined by its word and a negation as "not (...)". JSON the builder
 * cannot draw shows as it is.
 */
export function conditionText(condition: Condition, labels: ReadonlyMap<string, string>): string {
  switch (condition.kind) {
    case 'compare':
      return `${valueLabel(condition.left, labels)} ${COMPARE_SYMBOLS[condition.op]} ${literalText(condition.right)}`
    case 'group':
      return condition.items
        .map((item) =>
          item.kind === 'group' ? `(${conditionText(item, labels)})` : conditionText(item, labels)
        )
        .join(` ${condition.op} `)
    case 'not':
      return `not (${conditionText(condition.item, labels)})`
    case 'json':
      return condition.text
  }
}

/** The label of a value a condition reads: a field label, or Step and User for the context (FM-2). */
function valueLabel(path: string, labels: ReadonlyMap<string, string>): string {
  if (path === 'context.step') return 'Step'
  if (path === 'context.user') return 'User'
  return labels.get(path) ?? path
}

function literalText(value: Literal): string {
  return Array.isArray(value) ? value.map(String).join(', ') : String(value)
}

/**
 * Whether the signed-in person may make a structural change to the flow
 * (DF-5, S03): a grant that holds `flow.build` on the flow, on every flow or
 * on the organization. The server authorizes the change again (AC-1, I8).
 */
export function canBuild(grants: readonly Grant[], slug: string): boolean {
  const covering = new Set(['org', '*', 'flow:*', `flow:${slug}`])
  return grants.some((grant) => grant.scopes.includes('flow.build') && covering.has(grant.resource))
}

/**
 * The principal that a target's grant names (AS-1, ID-4, #252): a group grant
 * names `group:<id>` and a team grant names `team:<name>`, while a user grant
 * names the bare id. The server merges both spellings of a group and a team
 * into the principal's grants. A field or manager-of target resolves per
 * instance, so it names no principal here.
 */
export function principalOfTarget(target: string): string {
  const trimmed = target.trim()
  if (trimmed.startsWith('group:')) {
    const id = trimmed.slice('group:'.length).trim()
    return id === '' ? '' : `group:${id}`
  }
  if (trimmed.startsWith('team:')) {
    const name = trimmed.slice('team:'.length).trim()
    return name === '' ? '' : `team:${name}`
  }
  if (trimmed.startsWith('field:') || trimmed.startsWith('manager-of:')) return ''
  return userTargetOf(trimmed)
}

/**
 * The principals that a target's grant names (#232, ID-4). A `starter` target
 * names every configured starter, and the builder actor only when the flow
 * names none. A user target may be written `user:<id>` or `<id>`, so both
 * spellings reach the one immutable id that the grant and the definition use.
 */
function principalsOf(state: BuilderState, target: string): readonly string[] {
  if (target !== 'starter') return [principalOfTarget(target)]
  return state.starters.length > 0 ? state.starters : [state.actor]
}

/** The name of one grant row: the starter's principal or the user's id (ID-4). */
function targetLabel(state: BuilderState, target: string, principal: string): string {
  if (target !== 'starter') return principalOfTarget(target)
  return state.starters.length > 0 ? principal : 'the starter'
}

/**
 * The principal that the starter input names (#232, ID-4). `user:<id>` and a
 * bare id are the same user, and `team:<name>` stays one team for the engine.
 */
function principalOfStarter(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('team:') || trimmed.startsWith('group:')) {
    return principalOfTarget(trimmed)
  }
  return userTargetOf(trimmed)
}

/** The starters on one flow: grants on the flow that hold `instance.start` (#232). */
function startersOf(grants: readonly Grant[], slug: string): string[] {
  const resource = `flow:${slug}`
  const starters: string[] = []
  for (const grant of grants) {
    if (grant.resource !== resource) continue
    if (!grant.scopes.includes('instance.start')) continue
    if (!starters.includes(grant.principal)) starters.push(grant.principal)
  }
  return starters
}

/** The immutable id of a user target, without the optional `user:` prefix (ID-4). */
function userTargetOf(target: string): string {
  return target.startsWith('user:') ? target.slice('user:'.length).trim() : target
}

/** The ID of one grant operation, created once and reused on a retry (I1). */
function grantId(key: string): string {
  const held = grantIds.get(key)
  if (held !== undefined) return held
  const id = crypto.randomUUID()
  grantIds.set(key, id)
  return id
}

function grantKey(slug: string, step: string, principal: string, outcome: string): string {
  return `${slug}\u0000${step}\u0000${principal}\u0000${outcome}`
}

/** The ID key of the flow-level `instance.start` grant (#232). */
function starterGrantKey(slug: string, principal: string): string {
  return `${slug}\u0000starter\u0000${principal}`
}

/** The status element of the Starters section (#232). */
function starterStatusOf(state: BuilderState): HTMLElement {
  const element = state.root.querySelector<HTMLElement>('[data-starter-status]')
  if (element === null) throw new Error('the builder has no starter status element')
  return element
}

/** Split a comma-separated list, trimming and dropping empty entries. */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** A comma-separated list as an array, or undefined when it is empty. */
function listOrUndefined(text: string): string[] | undefined {
  const list = splitList(text)
  return list.length === 0 ? undefined : list
}

/** A trimmed string, or undefined when it is empty. */
function nonEmpty(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Set one key of a definition body, or delete it when the value is absent. */
function setOrDelete(body: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete body[key]
  else body[key] = value
}

/** One labelled text input of the builder. */
function textRow(text: string): { readonly row: HTMLElement; readonly input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'builder-field-row'
  const span = document.createElement('span')
  span.textContent = text
  row.appendChild(span)
  const input = document.createElement('input')
  input.type = 'text'
  row.appendChild(input)
  return { row, input }
}

/** One labelled positive-integer input of the builder, for a timer or a period setting (SE-3, SE-4, WF-5). */
function minuteRow(
  text: string,
  value: string,
  name: string
): { readonly row: HTMLElement; readonly input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'builder-field-row'
  const span = document.createElement('span')
  span.textContent = text
  row.appendChild(span)
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '1'
  input.step = '1'
  input.value = value
  input.dataset[name] = ''
  row.appendChild(input)
  return { row, input }
}

/** Read a positive integer from a builder input, or undefined when it is empty or invalid. */
function positiveMinutes(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined
  return Number(trimmed)
}

/** Read one positive-integer setting of a definition as the builder input's text (SE-3, SE-4, WF-5). */
function minutesOf(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? String(value) : ''
}

/** One labelled select of the builder. */
function selectRow(text: string): { readonly row: HTMLElement; readonly input: HTMLSelectElement } {
  const row = document.createElement('label')
  row.className = 'builder-field-row'
  const span = document.createElement('span')
  span.textContent = text
  row.appendChild(span)
  const input = document.createElement('select')
  row.appendChild(input)
  return { row, input }
}

function statusOf(state: BuilderState): HTMLElement {
  const element = state.root.querySelector<HTMLElement>('[data-builder-status]')
  if (element === null) throw new Error('the builder has no status element')
  return element
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
