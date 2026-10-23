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
  /** The interval between two reminders in minutes, as typed (SE-3, S12). */
  reminderMinutes: string
  /** The deadline from the task's start in minutes, as typed (SE-4, S12). */
  deadlineMinutes: string
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
    steps: readSteps(draft.definition),
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
      reminderMinutes: '',
      deadlineMinutes: '',
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

  root.appendChild(renderStarters(state))

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
    input.input.placeholder = 'starter, user:<id> or <id>'
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

  // The task's timers (SE-3, SE-4, S12): the reminder interval and the
  // deadline from the task's start, both in minutes. An empty input means the
  // step sets no reminder or no deadline, and the engine schedules nothing.
  const reminders = minuteRow(
    'Reminder every (minutes, empty for none)',
    step.reminderMinutes,
    'reminderMinutes'
  )
  reminders.input.addEventListener('input', () => {
    step.reminderMinutes = reminders.input.value
  })
  section.appendChild(reminders.row)

  const deadline = minuteRow(
    'Deadline (minutes, empty for none)',
    step.deadlineMinutes,
    'deadlineMinutes'
  )
  deadline.input.addEventListener('input', () => {
    step.deadlineMinutes = deadline.input.value
  })
  section.appendChild(deadline.row)

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
  for (const kind of BUILDER_CONTROLS) {
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

  if (CHOICE_CONTROLS.has(field.control)) {
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
      // that person starts. A user target is its immutable ID (ID-4).
      for (const principal of principalsOf(state, target)) {
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
 * like a target (ID-4): `user:<id>` and a bare id are the same user, and a
 * `team:<name>` stays a team. The builder appends the two grants the requester
 * needs and re-renders, so the outcome grid names the new starter at once.
 */
async function addStarter(state: BuilderState, input: HTMLInputElement): Promise<void> {
  const confirmation = starterStatusOf(state)
  const principal = principalOfStarter(input.value)
  if (principal === '') {
    confirmation.textContent = 'Enter a user:<id>, team:<name> or an id.'
    return
  }
  const first = state.steps[0]
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
        .map((target) =>
          target === 'starter' ? { starter: 'starter' } : { user: userTargetOf(target) }
        ),
      fields: step.fields.map((field) => ({
        key: field.key,
        control: field.control,
        ...(field.label.trim() === '' ? {} : { label: field.label }),
        ...(CHOICE_CONTROLS.has(field.control) ? { options: splitList(field.options) } : {}),
        ...(field.required ? { required: true } : {}),
      })),
      // The step's assignees edit the fields the builder adds (FM-3); without
      // this list the engine makes no field editable and the form is read-only.
      ...(step.fields.length === 0 ? {} : { editable: step.fields.map((field) => field.key) }),
      outcomes: splitList(step.outcomes),
      ...minutesField('reminderMinutes', step.reminderMinutes),
      ...minutesField('deadlineMinutes', step.deadlineMinutes),
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
    reminderMinutes: minutesOf(step.reminderMinutes),
    deadlineMinutes: minutesOf(step.deadlineMinutes),
    fields: fields.map(readField).filter((field): field is BuilderField => field !== undefined),
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
    fields: [],
  }
}

function readField(body: unknown): BuilderField | undefined {
  if (!isRecord(body) || typeof body.key !== 'string') return undefined
  const control = body.control
  return {
    key: body.key,
    label: typeof body.label === 'string' ? body.label : '',
    control: isBuilderControl(control) ? control : 'text',
    options: Array.isArray(body.options)
      ? body.options.filter((option): option is string => typeof option === 'string').join(', ')
      : '',
    required: body.required === true,
  }
}

/** Whether a definition names one of the controls the builder offers (FM-1). */
function isBuilderControl(value: unknown): value is BuilderControl {
  return typeof value === 'string' && (BUILDER_CONTROLS as readonly string[]).includes(value)
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

/**
 * The principals that a target's grant names (#232, ID-4). A `starter` target
 * names every configured starter, and the builder actor only when the flow
 * names none. A user target may be written `user:<id>` or `<id>`, so both
 * spellings reach the one immutable id that the grant and the definition use.
 */
function principalsOf(state: BuilderState, target: string): readonly string[] {
  if (target !== 'starter') return [userTargetOf(target)]
  return state.starters.length > 0 ? state.starters : [state.actor]
}

/** The name of one grant row: the starter's principal or the user's id (ID-4). */
function targetLabel(state: BuilderState, target: string, principal: string): string {
  if (target !== 'starter') return userTargetOf(target)
  return state.starters.length > 0 ? principal : 'the starter'
}

/**
 * The principal that the starter input names (#232, ID-4). `user:<id>` and a
 * bare id are the same user, and `team:<name>` stays one team for the engine.
 */
function principalOfStarter(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('team:')) {
    const name = trimmed.slice('team:'.length).trim()
    return name === '' ? '' : `team:${name}`
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

/** One labelled positive-integer input of the builder, for a step's timer settings (SE-3, SE-4). */
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

/** One timer setting of a step, written only when it is a positive integer (SE-3, SE-4). */
function minutesField(
  name: 'reminderMinutes' | 'deadlineMinutes',
  text: string
): Record<string, number> {
  const value = positiveMinutes(text)
  return value === undefined ? {} : { [name]: value }
}

/** Read a positive integer from a builder input, or undefined when it is empty or invalid. */
function positiveMinutes(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined
  return Number(trimmed)
}

/** Read one timer setting of a definition as the builder input's text (SE-3, SE-4). */
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
