// Issue #224, DF-1, DF-4, DF-5, FM-1, FM-3, I12, ADR 0009, ADR 0012: the
// builder. It loads the draft of one flow, edits the v2 definition as a form
// and writes it back through the public API client. It edits a step's key, its
// targets, its outcomes and its fields in place; it saves through
// `writeDraft` and publishes through `publishFlow`. The engine still decides
// whether the change is allowed, whether the definition is valid and what a
// publication records (A9, DF-5); the builder only shows the server's answer.
//
// Every step and field is plain DOM (ADR 0009). The grant controls post one
// `config.grant.changed@1` operation per checked target and outcome through
// `appendOperation`, so the holder of the step can choose the outcomes the
// form offers (AC-4). A grant operation keeps the ID the client chose (I1), so
// posting the same pair twice appends nothing the second time.

import {
  appendOperation,
  listFlows,
  type Operation,
  publishFlow,
  RequestRefused,
  readDraft,
  writeDraft,
} from '../client/client.js'

/** The event type of a grant change (AC-2, I14). */
const GRANT_CHANGE_TYPE = 'config.grant.changed@1'

/** The four controls that the builder edits (FM-1); a step's other controls stay read-only. */
type BuilderControl = 'text' | 'long-text' | 'select' | 'checkbox'

/** One field the builder edits in place. */
type BuilderField = {
  key: string
  label: string
  control: BuilderControl
  options: string
  required: boolean
}

/** One step the builder edits in place. */
type BuilderStep = {
  key: string
  targets: string[]
  outcomes: string
  fields: BuilderField[]
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
  steps: BuilderStep[]
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
  const [draft, flows] = await Promise.all([readDraft(options.slug), listFlows()])
  const summary = flows.find((flow) => flow.slug === options.slug)
  const state: BuilderState = {
    slug: options.slug,
    actor: options.actor,
    root: options.root,
    clock: options.clock,
    ids: options.ids,
    title: summary?.title,
    draftVersion: draft.version,
    steps: readSteps(draft.definition),
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
    if (state.steps.length > 0) {
      const last = state.steps[state.steps.length - 1]
      // The last step becomes a middle step, so its default outcome is the
      // approval that the next step receives (DF-4, FM-1).
      if (last.outcomes.trim() === '' || last.outcomes.trim() === 'submit')
        last.outcomes = 'approve'
    }
    state.steps.push({
      key: `step${state.steps.length + 1}`,
      targets: ['starter'],
      outcomes: 'submit',
      fields: [],
    })
    render(state)
  })
  controls.appendChild(addStep)

  const removeStep = document.createElement('button')
  removeStep.type = 'button'
  removeStep.textContent = 'Remove last step'
  removeStep.dataset.removeStep = ''
  removeStep.disabled = state.steps.length <= 1
  removeStep.addEventListener('click', () => {
    if (state.steps.length <= 1) return
    state.steps.pop()
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

  const steps = document.createElement('div')
  steps.id = 'builder-steps'
  state.steps.forEach((step, index) => {
    steps.appendChild(renderStep(state, step, index))
  })
  root.appendChild(steps)
}

/** Render one step's key, targets, outcomes, fields and grant controls. */
function renderStep(state: BuilderState, step: BuilderStep, index: number): HTMLElement {
  const section = document.createElement('section')
  section.className = 'builder-step'
  section.dataset.stepIndex = String(index)

  const heading = document.createElement('h2')
  heading.textContent = `Step ${index + 1}`
  section.appendChild(heading)

  const key = textRow('Key')
  key.input.value = step.key
  key.input.dataset.stepKey = ''
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
    input.input.placeholder = 'starter or a user id'
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
  outcomes.input.addEventListener('input', () => {
    step.outcomes = outcomes.input.value
  })
  outcomes.input.addEventListener('change', () => render(state))
  section.appendChild(outcomes.row)

  const fields = document.createElement('div')
  fields.className = 'builder-fields'
  const fieldHeading = document.createElement('h3')
  fieldHeading.textContent = 'Fields'
  fields.appendChild(fieldHeading)
  step.fields.forEach((field, fieldIndex) => {
    fields.appendChild(renderField(state, field, fieldIndex))
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
    })
    render(state)
  })
  fields.appendChild(addField)
  section.appendChild(fields)

  section.appendChild(renderGrants(state, step, index))
  return section
}

/** Render one field in place: its key, label, control, options and required mark. */
function renderField(state: BuilderState, field: BuilderField, index: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'builder-field'
  row.dataset.fieldIndex = String(index)

  const key = textRow('Field key')
  key.input.value = field.key
  key.input.dataset.fieldKey = ''
  key.input.addEventListener('input', () => {
    field.key = key.input.value
  })
  row.appendChild(key.row)

  const label = textRow('Label')
  label.input.value = field.label
  label.input.dataset.fieldLabel = ''
  label.input.addEventListener('input', () => {
    field.label = label.input.value
  })
  row.appendChild(label.row)

  const control = selectRow('Control')
  for (const kind of ['text', 'long-text', 'select', 'checkbox'] as const) {
    const option = document.createElement('option')
    option.value = kind
    option.textContent = kind
    control.input.appendChild(option)
  }
  control.input.value = field.control
  control.input.dataset.fieldControl = ''
  control.input.addEventListener('change', () => {
    field.control = control.input.value as BuilderControl
    render(state)
  })
  row.appendChild(control.row)

  if (field.control === 'select') {
    const options = textRow('Options (comma-separated)')
    options.input.value = field.options
    options.input.dataset.fieldOptions = ''
    options.input.addEventListener('input', () => {
      field.options = options.input.value
    })
    row.appendChild(options.row)
  }

  const requiredLabel = document.createElement('label')
  requiredLabel.className = 'inline'
  const required = document.createElement('input')
  required.type = 'checkbox'
  required.checked = field.required
  required.dataset.fieldRequired = ''
  required.addEventListener('change', () => {
    field.required = required.checked
  })
  requiredLabel.append(required, 'Required')
  row.appendChild(requiredLabel)

  return row
}

/**
 * Render the grant grid of one step: one checkbox per target and outcome, and
 * a control that posts the checked pairs. The default is checked, so a fresh
 * flow grants its own outcomes to its targets and is usable at once; the
 * selection stays visible and editable.
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
      // A `starter` target is dynamic: the grant names the signed-in
      // principal, because that is who the engine resolves `starter` to in an
      // instance this person starts. A user target is its immutable ID (ID-4).
      const principal = principalOf(state, target)
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
      label.append(checkbox, `${outcome} to ${target === 'starter' ? 'the starter' : target}`)
      grid.appendChild(label)
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

/** Write the draft through the API, and show the server's answer (DF-4, I5). */
async function saveDraft(state: BuilderState): Promise<void> {
  const status = statusOf(state)
  const definition = definitionOf(state)
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
    state.steps = readSteps(fresh.definition)
    render(state)
    const refreshed = statusOf(state)
    refreshed.textContent = `The draft changed; reloaded version ${fresh.version}. ${error.error}`
    return
  }
  status.textContent = messageOf(error)
}

/** The v2 definition the builder writes (DF-1, DF-4, I9). */
function definitionOf(state: BuilderState): Record<string, unknown> {
  return {
    schemaVersion: 2,
    steps: state.steps.map((step) => ({
      key: step.key,
      targets: step.targets
        .map((target) => target.trim())
        .filter((target) => target !== '')
        .map((target) => (target === 'starter' ? { starter: 'starter' } : { user: target })),
      fields: step.fields.map((field) => ({
        key: field.key,
        control: field.control,
        ...(field.label.trim() === '' ? {} : { label: field.label }),
        ...(field.control === 'select' ? { options: splitList(field.options) } : {}),
        ...(field.required ? { required: true } : {}),
      })),
      // The step's assignees edit the fields the builder adds (FM-3); without
      // this list the engine makes no field editable and the form is read-only.
      ...(step.fields.length === 0 ? {} : { editable: step.fields.map((field) => field.key) }),
      outcomes: splitList(step.outcomes),
    })),
  }
}

/** Read the steps of a v2 definition into the builder's editable model. */
function readSteps(definition: Record<string, unknown> | undefined): BuilderStep[] {
  if (definition === undefined) return [defaultStep(1)]
  const steps = Array.isArray(definition.steps) ? definition.steps : []
  if (steps.length === 0) return [defaultStep(1)]
  return steps.map((body, index) => readStep(body, index, steps.length))
}

function readStep(body: unknown, index: number, total: number): BuilderStep {
  const step = isRecord(body) ? body : {}
  const fields = Array.isArray(step.fields) ? step.fields : []
  const outcomes = Array.isArray(step.outcomes) ? step.outcomes : []
  return {
    key: typeof step.key === 'string' ? step.key : `step${index + 1}`,
    targets: readTargets(step.targets),
    outcomes:
      outcomes.length > 0 ? outcomes.join(', ') : index === total - 1 ? 'submit' : 'approve',
    fields: fields.map(readField).filter((field): field is BuilderField => field !== undefined),
  }
}

/** The builder's default step, matching the engine's starter definition (DF-1). */
function defaultStep(index: number): BuilderStep {
  return {
    key: index === 1 ? 'start' : `step${index}`,
    targets: ['starter'],
    outcomes: 'submit',
    fields: [],
  }
}

function readField(body: unknown): BuilderField | undefined {
  if (!isRecord(body) || typeof body.key !== 'string') return undefined
  const control = body.control
  return {
    key: body.key,
    label: typeof body.label === 'string' ? body.label : '',
    control:
      control === 'long-text' || control === 'select' || control === 'checkbox' ? control : 'text',
    options: Array.isArray(body.options)
      ? body.options.filter((option): option is string => typeof option === 'string').join(', ')
      : '',
    required: body.required === true,
  }
}

function readTargets(value: unknown): string[] {
  const targets = Array.isArray(value) ? value : []
  const read: string[] = []
  for (const target of targets) {
    if (!isRecord(target)) continue
    if (target.starter !== undefined) read.push('starter')
    else if (typeof target.user === 'string') read.push(target.user)
  }
  return read.length === 0 ? ['starter'] : read
}

/** The principal that a target names; `starter` is the person who starts the flow. */
function principalOf(state: BuilderState, target: string): string {
  return target === 'starter' ? state.actor : target
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

/** Split a comma-separated list, trimming and dropping empty entries. */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
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
