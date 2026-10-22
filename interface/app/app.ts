// Issue #106, #181, #184, #187, #224, FM-1, FM-2, FM-3, FM-4, FM-7, DX-1,
// DX-4, I12, A9, ADR 0009, ADR 0010, ADR 0012: the app shell, the browser
// surface. It signs in through the server session (or the `?actor=` harness
// seam), lists flows, creates a flow, renders a published flow's start form
// and an instance's current step, and opens the builder. It loads every flow
// through the generated client and never names an API path by hand (I12).
//
// The shell decides nothing: it runs no validation, no authorization and no
// routing (A9). The server resolves the start, the claim and the completion
// through the engine, so the shell names no `currentStep`, no `assignees` and
// no version except the one it read (I5). A refusal is the server's decision
// too (FM-3, FM-4): the client throws the refusal with its field errors by
// path, and the shell shows the reason in `.status` and each error at the
// control it names.
//
// The clock and the ID sources enter at one place, the mount options, so a
// caller can inject them. The defaults are Date.now and crypto.randomUUID, and
// the instance id has a source of its own, because it is not the operation id
// (DX-1, #187). This mirrors the engine's injected sources (I6); gui mode
// injects its own.

import {
  appendOperation,
  createFlow,
  type InstanceView,
  listFlows,
  loginUrl,
  logout,
  type Operation,
  RequestRefused,
  readFlow,
  readInstance,
  readSession,
  type Session,
  setClient,
} from '../client/client.js'
import {
  controlKind,
  type FormField,
  formModel,
  type JsonValue,
  type StepForm,
  stepKeys,
  stepOutcomes,
} from './form.js'

/** The versioned event type of a start (S06, MVP.md 9.1). */
const INSTANCE_STARTED = 'instance.started@1'

/** The versioned event type of a completion (S09, FM-4). */
const STEP_COMPLETED = 'step.completed@1'

/** The versioned event type of a claim (S09, AS-2). */
const STEP_CLAIMED = 'step.claimed@1'

export interface AppOptions {
  /** The element that receives the page. */
  readonly root: HTMLElement
  readonly baseUrl: string
  /** The flow that the URL names; absent on the flows list and the get-started page. */
  readonly slug: string
  /** The signed-in principal that acts on the flow (ID-2, ID-4). Empty outside the harness. */
  readonly actor: string
  /** The instance whose task page to show (FM-3, FM-4). */
  readonly instance?: string
  /** Whether the URL asks for the builder. */
  readonly builder?: boolean
  /** Whether the URL asks for the create-flow page. */
  readonly newFlow?: boolean
  /** The injected clock (I6); absent means Date.now. */
  readonly clock?: () => number
  /** The injected operation ID source (I1, I6); absent means crypto.randomUUID. */
  readonly ids?: () => string
  /** The injected instance ID source (DX-1, #187, I6); absent means crypto.randomUUID. */
  readonly instanceIds?: () => string
}

/** One page's mutable view state: the field readers and the rows a refusal names. */
type Page = {
  readonly root: HTMLElement
  readonly readers: Map<string, () => JsonValue | undefined>
  readonly rows: Map<string, HTMLElement>
}

/** Mount the page that the URL names (FM-1, FM-3, FM-4, A9, ADR 0012). */
export async function mountApp(options: AppOptions): Promise<void> {
  const clock = options.clock ?? (() => Date.now())
  const ids = options.ids ?? (() => crypto.randomUUID())
  const instanceIds = options.instanceIds ?? (() => crypto.randomUUID())
  const root = options.root
  root.replaceChildren()

  // The harness carries the principal in the URL and has no session. The
  // production page reads the session cookie, and a 401 starts the Keycloak
  // sign-in with this page as the return target (ADR 0012).
  const harnessActor = options.actor === '' ? undefined : options.actor
  let actor: string
  let displayName: string | undefined
  setClient({ baseUrl: options.baseUrl, token: '' })
  if (harnessActor !== undefined) {
    actor = harnessActor
    displayName = harnessActor
  } else {
    let session: Session
    try {
      session = await readSession()
    } catch (error: unknown) {
      if (error instanceof RequestRefused && error.status === 401) {
        location.assign(loginUrl(location.pathname + location.search))
        return
      }
      root.textContent = messageOf(error)
      return
    }
    setClient({ baseUrl: options.baseUrl, token: '', csrfToken: session.csrfToken })
    actor = session.principal.id
    displayName = session.principal.displayName
  }

  const header = document.createElement('header')
  header.className = 'app-header'
  const brand = document.createElement('a')
  brand.href = '/'
  brand.textContent = 'enform'
  header.appendChild(brand)
  if (displayName !== undefined) {
    const who = document.createElement('span')
    who.className = 'principal'
    who.textContent = displayName
    header.appendChild(who)
  }
  if (harnessActor === undefined) {
    const signOut = document.createElement('button')
    signOut.type = 'button'
    signOut.textContent = 'Sign out'
    signOut.dataset.logout = ''
    signOut.addEventListener('click', () => {
      void logout()
        .then(() => location.assign('/'))
        .catch((error: unknown) => {
          main.textContent = messageOf(error)
        })
    })
    header.appendChild(signOut)
  }
  const main = document.createElement('main')
  main.id = 'content'
  root.append(header, main)

  const page: Page = { root: main, readers: new Map(), rows: new Map() }

  const clearPage = (): void => {
    main.replaceChildren()
    page.readers.clear()
    page.rows.clear()
  }

  const readValues = (): Record<string, JsonValue> => {
    const values: Record<string, JsonValue> = {}
    for (const [key, read] of page.readers) {
      const value = read()
      if (value !== undefined) values[key] = value
    }
    return values
  }

  const renderField = (field: FormField, readValue: boolean): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'field'
    const label = document.createElement('label')
    label.textContent = field.label ?? field.key
    // The step read says which fields it requires (FM-2, FM-3). The page marks
    // them, so the person knows which field a refusal will name; it enforces
    // nothing, because only the server validates (A9, FM-4).
    if (field.required) {
      row.dataset.required = 'true'
      const mark = document.createElement('span')
      mark.className = 'required'
      mark.textContent = ' (required)'
      label.appendChild(mark)
    }
    row.appendChild(label)
    row.appendChild(renderControl(field, page.readers, readValue))
    page.rows.set(field.key, row)
    return row
  }

  const renderFields = (
    host: HTMLElement,
    fields: readonly FormField[],
    reads: (field: FormField) => boolean
  ): void => {
    for (const field of fields) host.appendChild(renderField(field, reads(field)))
  }

  const buildForm = (model: StepForm, reads: (field: FormField) => boolean): HTMLFormElement => {
    const form = document.createElement('form')
    for (const section of model.sections) {
      const group = document.createElement('section')
      const title = document.createElement('h2')
      title.textContent = section.key
      group.appendChild(title)
      renderFields(group, section.fields, reads)
      form.appendChild(group)
    }
    renderFields(form, model.fields, reads)
    return form
  }

  /**
   * Show a caught error (FM-4). A refusal that names field errors puts the
   * reason in `.status` and each error at the control of its path; any other
   * error keeps the plain message. The previous errors are cleared first, so a
   * second attempt does not stack them.
   */
  const clearErrors = (): void => {
    for (const node of main.querySelectorAll('[data-error-for]')) node.remove()
  }

  const showRefusal = (status: HTMLElement, form: HTMLElement, error: unknown): void => {
    clearErrors()
    if (error instanceof RequestRefused && error.errors.length > 0) {
      status.textContent = error.error
      for (const failure of error.errors) {
        const paragraph = document.createElement('p')
        paragraph.className = 'error'
        paragraph.dataset.errorFor = failure.path
        paragraph.textContent = failure.message
        const row = page.rows.get(failure.path) ?? form
        row.appendChild(paragraph)
      }
      return
    }
    status.textContent = messageOf(error)
  }

  const renderStart = async (slug: string): Promise<void> => {
    const flow = await readFlow(slug)
    const heading = document.createElement('h1')
    heading.textContent = flow.slug
    main.appendChild(heading)

    const stepKey = stepKeys(flow.definition)[0]
    if (stepKey === undefined) throw new Error('the flow has no step to show')
    const form = buildForm(formModel(flow.definition, stepKey), () => true)
    const status = document.createElement('p')
    status.className = 'status'
    const submit = document.createElement('button')
    submit.type = 'button'
    submit.textContent = 'Submit'
    submit.dataset.start = ''
    submit.addEventListener('click', () => {
      const instanceId = instanceIds()
      const intent: Operation = {
        id: ids(),
        type: INSTANCE_STARTED,
        at: clock(),
        actor,
        payload: { flow: slug, instanceId, values: readValues() },
      }
      void appendOperation(intent)
        .then(() => {
          clearErrors()
          status.textContent = 'Synced'
          // The start minted the instance; the person follows the link to the
          // task page (S06, DX-1).
          const link = document.createElement('p')
          link.className = 'instance-link'
          const anchor = document.createElement('a')
          anchor.href = `/?flow=${encodeURIComponent(slug)}&instance=${encodeURIComponent(instanceId)}`
          anchor.textContent = instanceId
          link.append('Instance ', anchor)
          form.appendChild(link)
        })
        .catch((error: unknown) => {
          showRefusal(status, form, error)
        })
    })
    form.appendChild(submit)
    form.appendChild(status)
    main.appendChild(form)
  }

  /**
   * Render one instance's current step for the actor (FM-3, FM-4, FM-7). The
   * engine's read decides what shows and who may edit; the page adds a claim
   * control when the current step has no holder, and one control per outcome
   * for the holder. An accepted claim or completion re-reads the instance, so
   * the page never shows the version it just left (I5).
   */
  const renderTask = async (slug: string, instanceId: string, flash?: string): Promise<void> => {
    // A claim or a completion re-enters this function, so it clears the page
    // itself; a nested read must not leave the old version above the new one.
    clearPage()
    const [flow, view] = await Promise.all([readFlow(slug), readInstance(instanceId, actor)])
    const heading = document.createElement('h1')
    heading.textContent = slug
    main.appendChild(heading)
    if (flash !== undefined) {
      const completed = document.createElement('p')
      completed.className = 'status'
      completed.textContent = flash
      main.appendChild(completed)
    }
    const instanceStatus = document.createElement('p')
    instanceStatus.className = 'instance-status'
    instanceStatus.textContent = statusLine(view.status)
    main.appendChild(instanceStatus)
    const stepKey = view.status.currentStep
    // A closed or finished instance has no current step, so it shows the
    // status line and no form (VT-1, FM-3).
    if (stepKey === undefined) return

    // The read serves JSON values (FM-7). The generated type widens them to
    // unknown, so the form narrows them at this seam and checks nothing.
    const values = view.values as Readonly<Record<string, JsonValue>>
    const form = buildForm(
      formModel(flow.definition, stepKey, values, view),
      (field) => field.editable
    )
    const status = document.createElement('p')
    status.className = 'status'

    if (view.status.holder !== actor) {
      const claimControl = document.createElement('button')
      claimControl.type = 'button'
      claimControl.textContent = 'Claim'
      claimControl.dataset.claim = ''
      claimControl.addEventListener('click', () => {
        const intent: Operation = {
          id: ids(),
          type: STEP_CLAIMED,
          at: clock(),
          actor,
          payload: { instanceId, expectedVersion: view.version },
        }
        void appendOperation(intent)
          .then(() => renderTask(slug, instanceId, 'Claimed'))
          .catch((error: unknown) => showRefusal(status, form, error))
      })
      form.appendChild(claimControl)
    }

    // The published definition names the outcomes the step offers (AC-4); the
    // engine authorizes the one the holder chooses and re-runs the rules (A9).
    for (const outcome of stepOutcomes(flow.definition, stepKey)) {
      const control = document.createElement('button')
      control.type = 'button'
      control.textContent = outcome
      control.dataset.outcome = outcome
      control.addEventListener('click', () => {
        const intent: Operation = {
          id: ids(),
          type: STEP_COMPLETED,
          at: clock(),
          actor,
          payload: { instanceId, version: view.version, outcome, values: readValues() },
        }
        void appendOperation(intent)
          .then(() => renderTask(slug, instanceId, 'Step completed'))
          .catch((error: unknown) => showRefusal(status, form, error))
      })
      form.appendChild(control)
    }
    form.appendChild(status)
    main.appendChild(form)
  }

  const renderFlows = async (create: boolean): Promise<void> => {
    const flows = await listFlows()
    if (create || flows.length === 0) {
      renderGetStarted(create)
      return
    }
    const heading = document.createElement('h1')
    heading.textContent = 'Flows'
    main.appendChild(heading)
    const list = document.createElement('ul')
    list.className = 'flows'
    for (const flow of flows) {
      const item = document.createElement('li')
      item.className = 'flow'
      item.dataset.flow = flow.slug
      const title = document.createElement('strong')
      title.textContent = flow.title ?? flow.slug
      item.appendChild(title)
      const slug = document.createElement('code')
      slug.textContent = flow.slug
      item.appendChild(slug)
      const versions = document.createElement('span')
      versions.className = 'versions'
      versions.textContent =
        flow.publishedVersion === undefined
          ? `draft v${flow.draftVersion}, not published`
          : `draft v${flow.draftVersion}, published v${flow.publishedVersion}`
      item.appendChild(versions)
      const edit = document.createElement('a')
      edit.href = `/?flow=${encodeURIComponent(flow.slug)}&builder=1`
      edit.textContent = 'Edit'
      item.appendChild(edit)
      if (flow.publishedVersion !== undefined) {
        const open = document.createElement('a')
        open.href = `/?flow=${encodeURIComponent(flow.slug)}`
        open.textContent = 'Open form'
        item.appendChild(open)
      }
      list.appendChild(item)
    }
    main.appendChild(list)
    const createLink = document.createElement('a')
    createLink.href = '/?new=1'
    createLink.textContent = 'New flow'
    createLink.dataset.newFlow = ''
    main.appendChild(createLink)
  }

  /** The empty get-started page: a title, one sentence and the create form. */
  const renderGetStarted = (creating: boolean): void => {
    const heading = document.createElement('h1')
    heading.textContent = creating ? 'Create a flow' : 'Build your first flow'
    main.appendChild(heading)
    const sentence = document.createElement('p')
    sentence.textContent =
      'A flow is a form that moves through steps, from the person who fills it to the people who approve it.'
    main.appendChild(sentence)

    const form = document.createElement('form')
    form.className = 'create-flow'
    const slugLabel = document.createElement('label')
    slugLabel.textContent = 'Slug'
    const slug = document.createElement('input')
    slug.name = 'slug'
    slug.id = 'flow-slug'
    slug.required = true
    slugLabel.appendChild(slug)
    form.appendChild(slugLabel)
    const titleLabel = document.createElement('label')
    titleLabel.textContent = 'Title (optional)'
    const title = document.createElement('input')
    title.name = 'title'
    title.id = 'flow-title'
    titleLabel.appendChild(title)
    form.appendChild(titleLabel)
    const create = document.createElement('button')
    create.type = 'submit'
    create.textContent = creating ? 'Create flow' : 'Create your first flow'
    form.appendChild(create)
    const status = document.createElement('p')
    status.className = 'status'
    form.appendChild(status)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = slug.value.trim()
      if (value === '') return
      const input =
        title.value.trim() === '' ? { slug: value } : { slug: value, title: title.value }
      void createFlow(input)
        .then(() => {
          location.assign(`/?flow=${encodeURIComponent(value)}&builder=1`)
        })
        .catch((error: unknown) => {
          status.textContent = messageOf(error)
        })
    })
    main.appendChild(form)
  }

  const renderRoute = async (): Promise<void> => {
    clearPage()
    const slug = options.slug.trim()
    if (slug === '') {
      await renderFlows(options.newFlow === true)
      return
    }
    if (options.newFlow === true) {
      renderGetStarted(true)
      return
    }
    if (options.builder === true) {
      await renderBuilder(slug)
      return
    }
    if (options.instance !== undefined) {
      await renderTask(slug, options.instance)
      return
    }
    await renderStart(slug)
  }

  // Issue #224 lands the builder in the next commit of this branch. Until it
  // arrives the URL shows the published form, so the intermediate commit still
  // serves a page.
  const renderBuilder = async (slug: string): Promise<void> => {
    await renderStart(slug)
  }

  try {
    await renderRoute()
  } catch (error: unknown) {
    main.textContent = messageOf(error)
  }
}

/** The status line of an instance (VT-1, VT-2, S14): position, state and holder. */
function statusLine(status: InstanceView['status']): string {
  const holder = status.holder === undefined ? '' : `, holder ${status.holder}`
  return `Step ${status.step} of ${status.totalSteps}: ${status.state}${holder}`
}

function renderControl(
  field: FormField,
  readers: Map<string, () => JsonValue | undefined>,
  readValue: boolean
): HTMLElement {
  // A completion captures only the fields the step read marks editable
  // (FM-3, FM-4), so a field the view locks registers no reader.
  const keep = (read: () => JsonValue | undefined): void => {
    if (readValue) readers.set(field.key, read)
  }
  const kind = controlKind(field.control)
  switch (kind) {
    case 'single-line': {
      const input = document.createElement('input')
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      keep(() => input.value)
      return input
    }
    case 'date': {
      const input = document.createElement('input')
      input.type = 'date'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      // An empty date omits its key: the engine's validator never accepts ''.
      keep(() => (input.value === '' ? undefined : input.value))
      return input
    }
    case 'email': {
      const input = document.createElement('input')
      input.type = 'email'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      keep(() => input.value)
      return input
    }
    case 'tel': {
      const input = document.createElement('input')
      input.type = 'tel'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      keep(() => input.value)
      return input
    }
    case 'textarea': {
      const textarea = document.createElement('textarea')
      textarea.name = field.key
      textarea.disabled = !field.editable
      if (typeof field.value === 'string') textarea.value = field.value
      keep(() => textarea.value)
      return textarea
    }
    case 'number': {
      const input = document.createElement('input')
      input.type = 'number'
      if (field.control === 'money') input.step = '0.01'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'number') input.value = String(field.value)
      // An empty number omits its key: Number('') is 0, which is a value the
      // user did not enter.
      keep(() => (input.value === '' ? undefined : Number(input.value)))
      return input
    }
    case 'select': {
      const select = document.createElement('select')
      select.name = field.key
      select.disabled = !field.editable
      for (const option of field.options) {
        const element = document.createElement('option')
        element.value = option
        element.textContent = option
        select.appendChild(element)
      }
      if (typeof field.value === 'string') select.value = field.value
      keep(() => (select.value === '' ? undefined : select.value))
      return select
    }
    case 'checkboxes': {
      const group = document.createElement('div')
      const boxes: HTMLInputElement[] = []
      for (const option of field.options) {
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.name = field.key
        box.value = option
        box.disabled = !field.editable
        if (Array.isArray(field.value) && field.value.includes(option)) box.checked = true
        const optionLabel = document.createElement('label')
        optionLabel.appendChild(box)
        optionLabel.appendChild(document.createTextNode(option))
        group.appendChild(optionLabel)
        boxes.push(box)
      }
      keep(() => boxes.filter((box) => box.checked).map((box) => box.value))
      return group
    }
    case 'radios': {
      const group = document.createElement('div')
      const radios: HTMLInputElement[] = []
      // The engine accepts only 'yes' and 'no' for a yes-no control, so it
      // renders as two radios with those values (FM-1).
      const options = field.control === 'yes-no' ? ['yes', 'no'] : field.options
      for (const option of options) {
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = field.key
        radio.value = option
        radio.disabled = !field.editable
        if (field.value === option) radio.checked = true
        const optionLabel = document.createElement('label')
        optionLabel.appendChild(radio)
        optionLabel.appendChild(document.createTextNode(option))
        group.appendChild(optionLabel)
        radios.push(radio)
      }
      keep(() => radios.find((radio) => radio.checked)?.value ?? null)
      return group
    }
    case 'switch': {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.name = field.key
      input.disabled = !field.editable
      input.checked = field.value === true
      keep(() => input.checked)
      return input
    }
    case 'file': {
      const input = document.createElement('input')
      input.type = 'file'
      input.name = field.key
      input.disabled = !field.editable
      // No chosen file omits its key; a chosen file contributes its name.
      keep(() => input.files?.[0]?.name)
      return input
    }
    case 'person': {
      const input = document.createElement('input')
      input.type = 'text'
      input.name = field.key
      input.disabled = !field.editable
      if (typeof field.value === 'string') input.value = field.value
      // ID-4: a person is an immutable principal. The public API has no
      // directory read yet, so the form takes the principal as text and does
      // not invent a lookup.
      keep(() => input.value)
      return input
    }
    case 'static': {
      const text = document.createElement('div')
      text.className = 'static'
      text.dataset.field = field.key
      text.textContent = field.value === undefined ? '' : String(field.value)
      return text
    }
    case 'repeating': {
      const fieldset = document.createElement('fieldset')
      fieldset.className = 'repeating'
      fieldset.dataset.field = field.key
      const rows: HTMLTextAreaElement[] = []
      const list = document.createElement('div')
      const add = document.createElement('input')
      add.type = 'button'
      add.value = 'Add row'
      add.dataset.addRow = field.key
      const addRow = (text: string): void => {
        const row = document.createElement('div')
        const textarea = document.createElement('textarea')
        textarea.name = field.key
        textarea.disabled = !field.editable
        textarea.value = text
        rows.push(textarea)
        const remove = document.createElement('input')
        remove.type = 'button'
        remove.value = 'Remove'
        remove.dataset.removeRow = field.key
        remove.addEventListener('click', () => {
          const index = rows.indexOf(textarea)
          if (index >= 0) rows.splice(index, 1)
          row.remove()
        })
        row.appendChild(textarea)
        row.appendChild(remove)
        list.appendChild(row)
      }
      add.addEventListener('click', () => addRow(''))
      fieldset.appendChild(list)
      fieldset.appendChild(add)
      if (Array.isArray(field.value)) {
        for (const record of field.value) addRow(JSON.stringify(record))
      }
      keep(() => {
        const records: JsonValue[] = []
        for (const row of rows) {
          const text = row.value.trim()
          if (text === '') continue
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            records.push(text)
            continue
          }
          // A row that is not a JSON object contributes its raw text, so the
          // server refuses it by field path (FM-4); the shell decides nothing.
          records.push(isJsonObject(parsed) ? parsed : text)
        }
        return records.length === 0 ? undefined : records
      })
      return fieldset
    }
  }
}

/** A JSON object: not null and not an array. */
function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
