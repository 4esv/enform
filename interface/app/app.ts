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
  type CreatedUser,
  createFlow,
  createUser,
  type DirectoryGroup,
  type DirectoryUser,
  type InstanceView,
  listFlows,
  listGroups,
  listUnroutable,
  listUsers,
  loginUrl,
  logout,
  type Note,
  type Operation,
  RequestRefused,
  readFlow,
  readInbox,
  readInstance,
  readInstanceTimeline,
  readSession,
  readTimeline,
  type Session,
  setClient,
  type TimelineEntry,
  type TrackerStep,
  type UnroutableItem,
} from '../client/client.js'
import { mountBuilder } from './builder.js'
import {
  controlKind,
  type FormField,
  formModel,
  type JsonValue,
  type StepForm,
  stepKeys,
} from './form.js'

/** The versioned event type of a start (S06, MVP.md 9.1). */
const INSTANCE_STARTED = 'instance.started@1'

/** The versioned event type of a completion (S09, FM-4). */
const STEP_COMPLETED = 'step.completed@1'

/** The versioned event type of a claim (S09, AS-2). */
const STEP_CLAIMED = 'step.claimed@1'

/** The versioned event type of a send back (S11, WF-3). */
const STEP_SENT_BACK = 'step.sent-back@1'

/** The versioned event type of a withdrawal (S13, WF-4). */
const INSTANCE_WITHDRAWN = 'instance.withdrawn@1'

/** The versioned event type of a cancellation (S13, WF-4). */
const INSTANCE_CANCELLED = 'instance.cancelled@1'

/** The versioned event type of the undo of a close (S13, WF-5). */
const INSTANCE_UNDONE = 'instance.undone@1'

/** The versioned event type of a takeover (S10, AS-3). */
const STEP_TAKEN_OVER = 'step.taken-over@1'

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
  /** Whether the URL asks for the inbox. */
  readonly inbox?: boolean
  /** The inbox tab that the URL names; absent means `my` (VT-1). */
  readonly inboxTab?: string
  /** Whether the URL asks for the directory users page (ID-6). */
  readonly users?: boolean
  /** Whether the URL asks for the directory groups page (ID-6, AS-1). */
  readonly groups?: boolean
  /** Whether the URL asks for the Unroutable queue (I10, AS-5). */
  readonly queue?: boolean
  /** Whether the URL asks for the global change feed (VT-6). */
  readonly changes?: boolean
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
  const inbox = document.createElement('a')
  inbox.href = '/?inbox=1'
  inbox.textContent = 'Inbox'
  inbox.dataset.inbox = ''
  header.appendChild(inbox)
  // The global change feed (VT-6). The link is always offered; the server
  // refuses a principal without `instance.timeline` and the page shows the
  // reason, so the shell decides nothing (A9, I8).
  const changes = document.createElement('a')
  changes.href = '/?changes=1'
  changes.textContent = 'Changes'
  changes.dataset.changes = ''
  header.appendChild(changes)
  // Issue #228, ID-6: the directory is an administrator surface. The link is
  // always offered; the page shows the server's 403 to a principal without
  // `org.grants` (I8), so the shell decides nothing (A9).
  const users = document.createElement('a')
  users.href = '/?users=1'
  users.textContent = 'Users'
  users.dataset.users = ''
  header.appendChild(users)
  // Issue #252, ID-6, AS-1: the groups and their members, the directory read
  // that a group target names. The link is always offered; the page shows the
  // server's 403 to a principal without `org.grants` (I8), as Users does.
  const groups = document.createElement('a')
  groups.href = '/?groups=1'
  groups.textContent = 'Groups'
  groups.dataset.groups = ''
  header.appendChild(groups)
  // Issue #252, I10, AS-5: the Unroutable queue. The flow owner reads the
  // tasks that resolved to nobody; the server authorizes every row (I8).
  const queue = document.createElement('a')
  queue.href = '/?queue=1'
  queue.textContent = 'Queue'
  queue.dataset.queue = ''
  header.appendChild(queue)
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
   * Render one instance's current step for the actor (FM-3, FM-4, FM-7, #228).
   * The engine's read decides what shows and who may edit, and it carries the
   * visible field definitions and the step's outcomes, so an assignee who
   * holds only the step's outcome grant renders and completes the task without
   * reading the whole published flow (AC-4, I8). The page adds a claim control
   * when the current step has no holder, and one control per outcome for the
   * holder. An accepted claim or completion re-reads the instance, so the page
   * never shows the version it just left (I5).
   */
  const renderTask = async (slug: string, instanceId: string, flash?: string): Promise<void> => {
    // A claim or a completion re-enters this function, so it clears the page
    // itself; a nested read must not leave the old version above the new one.
    clearPage()
    const view = await readInstance(instanceId, actor)
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
    renderTracker(view.tracker, view.status.currentStep)
    renderNotes(view.notes)
    await renderTimeline(instanceId)
    const stepKey = view.status.currentStep
    // A closed or finished instance has no current step, so it shows the
    // status line and no form (VT-1, FM-3). A closed instance shows the
    // closer, the reason and the undo window instead (S13, WF-4, WF-5).
    if (stepKey === undefined) {
      if (view.status.state === 'done') {
        const done = document.createElement('p')
        done.className = 'done'
        done.dataset.done = ''
        done.textContent = 'Done'
        main.appendChild(done)
      } else if (view.withdrawal !== undefined) {
        main.appendChild(renderCloseState(slug, instanceId, view))
      }
      return
    }

    // The read serves JSON values (FM-7). The generated type widens them to
    // unknown, so the form narrows them at this seam and checks nothing.
    const values = view.values as Readonly<Record<string, JsonValue>>
    const form = buildForm(formModel(undefined, stepKey, values, view), (field) => field.editable)
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
          .catch(async (error: unknown) => {
            // A stale or refused claim re-reads: the holder the engine names
            // is the one the page must show (I5, AS-2).
            if (
              error instanceof RequestRefused &&
              error.status === 409 &&
              error.errors.length === 0
            ) {
              await renderTask(slug, instanceId, error.error)
              return
            }
            showRefusal(status, form, error)
          })
      })
      form.appendChild(claimControl)
    }

    // The instance read names the outcomes the step offers (AC-4); the engine
    // authorizes the one the holder chooses and re-runs the rules (A9). Only
    // the holder may choose one, so the controls wait for the claim.
    if (view.status.holder === actor) {
      for (const outcome of view.outcomes) {
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
            .catch(async (error: unknown) => {
              // A stale completion or a refusal that names no field re-reads,
              // so the page shows the state the log now holds (I5, FM-4). A
              // field error stays beside the control the engine named.
              if (
                error instanceof RequestRefused &&
                error.status === 409 &&
                error.errors.length === 0
              ) {
                await renderTask(slug, instanceId, error.error)
                return
              }
              showRefusal(status, form, error)
            })
        })
        form.appendChild(control)
      }
    }
    form.appendChild(status)
    main.appendChild(form)

    // The starter may withdraw the open instance and a principal with
    // `instance.cancel` may cancel it (S13, WF-4, AC-5). The read says which
    // controls the actor may see; the engine still decides the write (A9).
    if (view.canWithdraw || view.canCancel) {
      main.appendChild(renderClose(slug, instanceId, view))
    }

    // A holder may return the current step to an earlier one with a comment
    // (S11, WF-3). The read names the steps it may choose (`previousSteps`),
    // and the engine still decides the holder, the target, the comment and the
    // version (A9); the page only renders the controls and shows the refusal.
    if (view.status.holder === actor && view.previousSteps.length > 0) {
      main.appendChild(renderSendBack(slug, instanceId, view))
    }

    // An assignee may take over a task that another person holds when the step
    // allows it (S10, AS-3). The read decides who may see the control and how
    // long the holder must be idle; the engine still measures the idle period
    // and reassigns the task (A9, I5).
    if (view.canTakeOver) {
      main.appendChild(renderTakeover(slug, instanceId, view))
    }
  }

  /**
   * The per-step tracker of an instance (VT-2, S14, #244): one entry per
   * definition step in order, the one state it shows, and the reason a step
   * was skipped or sent back. It is read-only; the task controls stay below it.
   * The engine computes every state (A9), and the page only renders the read.
   */
  const renderTracker = (
    tracker: readonly TrackerStep[],
    currentStep: string | undefined
  ): void => {
    const list = document.createElement('ol')
    list.className = 'tracker'
    list.dataset.tracker = ''
    for (const step of tracker) {
      const item = document.createElement('li')
      item.className = 'tracker-step'
      item.dataset.trackerStep = step.key
      item.dataset.trackerState = step.state
      const key = document.createElement('span')
      key.className = 'tracker-key'
      key.textContent = step.key
      const state = document.createElement('span')
      state.className = 'tracker-state'
      state.textContent = trackerLabel(step.state)
      item.append(key, state)
      if (step.holder !== undefined) {
        const holder = document.createElement('span')
        holder.className = 'tracker-holder'
        holder.textContent = `holder ${step.holder}`
        item.append(holder)
      }
      if (step.startAt !== undefined) {
        const started = document.createElement('time')
        started.className = 'tracker-start'
        started.dataset.trackerStart = ''
        started.dateTime = new Date(step.startAt).toISOString()
        started.textContent = `started ${started.dateTime}`
        item.append(started)
      }
      if (step.lastActivityAt !== undefined) {
        const activity = document.createElement('time')
        activity.className = 'tracker-activity'
        activity.dataset.trackerActivity = ''
        activity.dateTime = new Date(step.lastActivityAt).toISOString()
        activity.textContent = `last activity ${activity.dateTime}`
        item.append(activity)
      }
      // The step's due time comes from its deadline (VT-2, SE-4, S12). The
      // engine computes it, and the page only renders the read. The relative
      // label uses the page clock, and the absolute time stays in the tooltip
      // and the `datetime` attribute (VT-2).
      if (step.dueAt !== undefined) {
        const due = document.createElement('time')
        due.className = 'tracker-due'
        due.dataset.trackerDue = ''
        due.dateTime = new Date(step.dueAt).toISOString()
        due.title = due.dateTime
        due.textContent = relativeDue(step.dueAt, clock())
        item.append(due)
      }
      if (step.condition !== undefined) {
        const condition = document.createElement('span')
        condition.className = 'tracker-condition'
        condition.textContent = `skipped when ${JSON.stringify(step.condition)}`
        item.append(condition)
      }
      if (step.comment !== undefined) {
        const comment = document.createElement('p')
        comment.className = 'tracker-comment'
        comment.textContent = step.comment
        item.append(comment)
      }
      if (step.key === currentStep) item.dataset.current = ''
      list.append(item)
    }
    main.append(list)
  }

  /**
   * The notes on the instance that this actor may read (VT-3, WF-3): the
   * send-back comment shows to the target step's people, and the approver
   * never sees a note it may not read.
   */
  const renderNotes = (notes: readonly Note[]): void => {
    if (notes.length === 0) return
    const heading = document.createElement('h2')
    heading.textContent = 'Notes'
    const list = document.createElement('ul')
    list.className = 'notes'
    list.dataset.notes = ''
    for (const note of notes) {
      const item = document.createElement('li')
      item.className = 'note'
      item.dataset.note = ''
      item.dataset.noteStep = note.step
      item.dataset.noteActor = note.actor
      const step = document.createElement('span')
      step.className = 'note-step'
      step.textContent = note.step
      const author = document.createElement('span')
      author.className = 'note-actor'
      author.textContent = note.actor
      const comment = document.createElement('p')
      comment.className = 'note-comment'
      comment.textContent = note.comment
      item.append(step, author, comment)
      list.appendChild(item)
    }
    main.append(heading, list)
  }

  /**
   * The close controls of an open instance (S13, WF-4): Withdraw for the
   * starter, with an optional reason, and Cancel for a principal that holds
   * `instance.cancel`, with a required reason (MVP.md 5.6). Each posts the
   * intent and re-reads on success; a refusal that names no field is the
   * server's reason, so the page shows the state the log now holds (I5).
   */
  const renderClose = (slug: string, instanceId: string, view: InstanceView): HTMLElement => {
    const section = document.createElement('section')
    section.className = 'close'
    section.dataset.closeSection = ''

    const control = (
      label: string,
      action: 'withdraw' | 'cancel',
      type: string,
      reasonRequired: boolean
    ): HTMLFormElement => {
      const form = document.createElement('form')
      const heading = document.createElement('h2')
      heading.textContent = action === 'withdraw' ? 'Withdraw' : 'Cancel'
      form.appendChild(heading)

      const reasonLabel = document.createElement('label')
      reasonLabel.textContent = reasonRequired ? 'Reason (required)' : 'Reason (optional)'
      const reason = document.createElement('textarea')
      reason.name = 'reason'
      reason.required = reasonRequired
      if (action === 'withdraw') reason.dataset.withdrawReason = ''
      else reason.dataset.cancelReason = ''
      reasonLabel.appendChild(reason)
      form.appendChild(reasonLabel)

      const submit = document.createElement('button')
      submit.type = 'submit'
      submit.textContent = action === 'withdraw' ? 'Withdraw' : 'Cancel'
      if (action === 'withdraw') submit.dataset.withdraw = ''
      else submit.dataset.cancel = ''
      form.appendChild(submit)

      const status = document.createElement('p')
      status.className = 'status'
      form.appendChild(status)

      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const intent: Operation = {
          id: ids(),
          type,
          at: clock(),
          actor,
          payload: { instanceId, reason: reason.value, version: view.version },
        }
        void appendOperation(intent)
          .then(() => renderTask(slug, instanceId, label))
          .catch(async (error: unknown) => {
            if (
              error instanceof RequestRefused &&
              error.status === 409 &&
              error.errors.length === 0
            ) {
              await renderTask(slug, instanceId, error.error)
              return
            }
            showRefusal(status, form, error)
          })
      })
      return form
    }

    if (view.canWithdraw) {
      section.appendChild(control('Withdrawn', 'withdraw', INSTANCE_WITHDRAWN, false))
    }
    if (view.canCancel) {
      section.appendChild(control('Cancelled', 'cancel', INSTANCE_CANCELLED, true))
    }
    return section
  }

  /**
   * The close state of a closed instance (S13, WF-4, WF-5): what closed it,
   * who closed it and why, and Undo for the closer while the flow's period is
   * open. The undo posts the compensating intent and re-reads, so the task
   * returns at the previous step and holder.
   */
  const renderCloseState = (slug: string, instanceId: string, view: InstanceView): HTMLElement => {
    const section = document.createElement('section')
    section.className = 'close'
    section.dataset.close = ''
    const kind = view.withdrawal === 'cancelled' ? 'cancelled' : 'withdrawn'
    section.dataset.withdrawal = kind

    const heading = document.createElement('h2')
    heading.textContent = kind === 'cancelled' ? 'Cancelled' : 'Withdrawn'
    section.appendChild(heading)

    if (view.closedBy !== undefined) {
      const closer = document.createElement('p')
      closer.className = 'close-by'
      closer.dataset.closeBy = view.closedBy
      closer.textContent = `Closed by ${view.closedBy}`
      section.appendChild(closer)
    }
    if (view.closeReason !== undefined && view.closeReason !== '') {
      const reason = document.createElement('p')
      reason.className = 'close-reason'
      reason.dataset.closeReason = ''
      reason.textContent = `Reason: ${view.closeReason}`
      section.appendChild(reason)
    }

    const status = document.createElement('p')
    status.className = 'status'
    if (view.closedBy === actor && view.undoUntil !== undefined && view.undoUntil > clock()) {
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.textContent = 'Undo'
      undo.dataset.undo = ''
      undo.addEventListener('click', () => {
        const intent: Operation = {
          id: ids(),
          type: INSTANCE_UNDONE,
          at: clock(),
          actor,
          payload: { instanceId, version: view.version },
        }
        void appendOperation(intent)
          .then(() => renderTask(slug, instanceId, 'Undone'))
          .catch((error: unknown) => {
            showRefusal(status, section, error)
          })
      })
      section.appendChild(undo)
    }
    section.appendChild(status)
    return section
  }

  /**
   * The send-back form (S11, WF-3): the earlier steps the read offers, a
   * required comment and a submit. It posts the intent and re-reads the
   * instance on success; a refusal that names no field re-reads too, so the
   * page shows the state the log now holds (I5).
   */
  const renderSendBack = (slug: string, instanceId: string, view: InstanceView): HTMLElement => {
    const section = document.createElement('section')
    section.className = 'send-back'
    section.dataset.sendBackSection = ''
    const heading = document.createElement('h2')
    heading.textContent = 'Send back'
    section.appendChild(heading)

    const form = document.createElement('form')
    const stepLabel = document.createElement('label')
    stepLabel.textContent = 'Send back to'
    const select = document.createElement('select')
    select.name = 'to'
    select.dataset.sendBackStep = ''
    for (const key of view.previousSteps) {
      const option = document.createElement('option')
      option.value = key
      option.textContent = key
      select.appendChild(option)
    }
    stepLabel.appendChild(select)
    form.appendChild(stepLabel)

    const commentLabel = document.createElement('label')
    commentLabel.textContent = 'Comment (required)'
    const comment = document.createElement('textarea')
    comment.name = 'comment'
    comment.required = true
    comment.dataset.sendBackComment = ''
    commentLabel.appendChild(comment)
    form.appendChild(commentLabel)

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = 'Send back'
    submit.dataset.sendBack = ''
    form.appendChild(submit)

    const status = document.createElement('p')
    status.className = 'status'
    form.appendChild(status)

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const intent: Operation = {
        id: ids(),
        type: STEP_SENT_BACK,
        at: clock(),
        actor,
        payload: {
          instanceId,
          to: select.value,
          comment: comment.value,
          version: view.version,
        },
      }
      void appendOperation(intent)
        .then(() => renderTask(slug, instanceId, 'Sent back'))
        .catch(async (error: unknown) => {
          if (
            error instanceof RequestRefused &&
            error.status === 409 &&
            error.errors.length === 0
          ) {
            await renderTask(slug, instanceId, error.error)
            return
          }
          showRefusal(status, form, error)
        })
    })

    section.appendChild(form)
    return section
  }

  /**
   * The takeover form (S10, AS-3): a required reason and a submit. When the
   * read names a `takeoverAvailableAt` that is still in the future, the page
   * shows the remaining idle time and disables the control; the server refuses
   * the takeover either way. The submit posts the intent and re-reads the
   * instance, so the page shows the new holder and the reason the takers gave.
   */
  const renderTakeover = (slug: string, instanceId: string, view: InstanceView): HTMLElement => {
    const section = document.createElement('section')
    section.className = 'takeover'
    section.dataset.takeoverSection = ''
    const heading = document.createElement('h2')
    heading.textContent = 'Take over'
    section.appendChild(heading)

    const remaining =
      view.takeoverAvailableAt === undefined ? 0 : view.takeoverAvailableAt - clock()
    const waiting = remaining > 0
    if (waiting) {
      const wait = document.createElement('p')
      wait.className = 'takeover-wait'
      wait.dataset.takeoverWait = ''
      wait.textContent = `The holder must be idle before a takeover: ${remainingLabel(remaining)} left.`
      section.appendChild(wait)
    }

    const form = document.createElement('form')
    const reasonLabel = document.createElement('label')
    reasonLabel.textContent = 'Reason (required)'
    const reason = document.createElement('textarea')
    reason.name = 'reason'
    reason.required = true
    reason.dataset.takeoverReason = ''
    reasonLabel.appendChild(reason)
    form.appendChild(reasonLabel)

    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = 'Take over'
    submit.dataset.takeover = ''
    submit.disabled = waiting
    form.appendChild(submit)

    const status = document.createElement('p')
    status.className = 'status'
    form.appendChild(status)

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const why = reason.value.trim()
      if (submit.disabled || why === '') return
      const intent: Operation = {
        id: ids(),
        type: STEP_TAKEN_OVER,
        at: clock(),
        actor,
        payload: { instanceId, reason: why, version: view.version },
      }
      void appendOperation(intent)
        .then(() => renderTask(slug, instanceId, `Taken over: ${why}`))
        .catch(async (error: unknown) => {
          if (
            error instanceof RequestRefused &&
            error.status === 409 &&
            error.errors.length === 0
          ) {
            await renderTask(slug, instanceId, error.error)
            return
          }
          showRefusal(status, form, error)
        })
    })

    section.appendChild(form)
    return section
  }

  /**
   * The instance timeline (S15, VT-5, I4): the instance's own events in log
   * order, read through the generated client. The toggle re-reads with the
   * flow's configuration changes when the server lets this actor see them; a
   * 403 shows the server's reason and leaves the instance events in place.
   * The timeline is read-only; the task controls stay below it.
   */
  const renderTimeline = async (instanceId: string): Promise<void> => {
    const section = document.createElement('section')
    section.className = 'timeline-section'
    section.dataset.timelineSection = ''
    const heading = document.createElement('h2')
    heading.textContent = 'Timeline'
    section.appendChild(heading)

    const toggleLabel = document.createElement('label')
    toggleLabel.className = 'timeline-toggle'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.dataset.timelineChanges = ''
    toggleLabel.append(toggle, ' Include configuration changes')
    section.appendChild(toggleLabel)

    const status = document.createElement('p')
    status.className = 'timeline-status'
    status.dataset.timelineStatus = ''
    const list = document.createElement('div')
    section.append(status, list)
    main.appendChild(section)

    const load = async (includeChanges: boolean): Promise<void> => {
      status.textContent = ''
      try {
        const entries = await readInstanceTimeline(
          instanceId,
          includeChanges ? '1' : undefined,
          actor
        )
        list.replaceChildren(renderTimelineList(entries))
      } catch (error: unknown) {
        status.textContent = reasonOf(error)
      }
    }
    toggle.addEventListener('change', () => {
      void load(toggle.checked)
    })
    await load(false)
  }

  /**
   * The global change feed (S15, VT-6, I4): the log in one order, filtered by
   * flow slug and by event type. The administrator or flow owner reads it; a
   * principal without the scope sees the server's 403 reason.
   */
  const renderChanges = async (): Promise<void> => {
    const heading = document.createElement('h1')
    heading.textContent = 'Changes'
    main.appendChild(heading)

    const form = document.createElement('form')
    form.className = 'change-filters'
    const flowLabel = document.createElement('label')
    flowLabel.textContent = 'Flow'
    const flow = document.createElement('input')
    flow.name = 'flow'
    flow.dataset.changeFlow = ''
    flow.value = options.slug
    flowLabel.appendChild(flow)
    const typeLabel = document.createElement('label')
    typeLabel.textContent = 'Type'
    const type = document.createElement('input')
    type.name = 'type'
    type.dataset.changeType = ''
    typeLabel.appendChild(type)
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.textContent = 'Filter'
    submit.dataset.changeFilter = ''
    form.append(flowLabel, typeLabel, submit)

    const status = document.createElement('p')
    status.className = 'status'
    const list = document.createElement('div')
    form.appendChild(status)
    main.append(form, list)

    const load = async (): Promise<void> => {
      status.textContent = ''
      try {
        const entries = await readTimeline(
          flow.value.trim() === '' ? undefined : flow.value.trim(),
          type.value.trim() === '' ? undefined : type.value.trim(),
          actor
        )
        list.replaceChildren(renderTimelineList(entries))
      } catch (error: unknown) {
        list.replaceChildren()
        status.textContent = reasonOf(error)
      }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void load()
    })
    await load()
  }

  /**
   * One timeline list (S15, VT-5, VT-6). Each entry is one event in the one
   * global order (I4), with the event in plain language, its actor, its time,
   * its step and comment when it carries them, and a connector call's
   * operation, time and outcome (I13). The list is a projection; it decides
   * nothing.
   */
  const renderTimelineList = (entries: readonly TimelineEntry[]): HTMLElement => {
    if (entries.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.dataset.timelineEmpty = ''
      empty.textContent = 'Nothing has happened yet.'
      return empty
    }
    const list = document.createElement('ol')
    list.className = 'timeline'
    list.dataset.timeline = ''
    for (const entry of entries) {
      const item = document.createElement('li')
      item.className = 'timeline-entry'
      item.dataset.timelineSeq = String(entry.seq)
      item.dataset.timelineType = entry.type
      const type = document.createElement('span')
      type.className = 'timeline-type'
      type.textContent = timelineLabel(entry.type)
      const at = document.createElement('time')
      at.className = 'timeline-at'
      at.dateTime = new Date(entry.at).toISOString()
      at.textContent = at.dateTime
      item.append(type, at)
      if (entry.actor !== undefined) {
        const actor = document.createElement('span')
        actor.className = 'timeline-actor'
        actor.textContent = entry.actor
        item.append(actor)
      }
      if (entry.step !== undefined) {
        const step = document.createElement('span')
        step.className = 'timeline-step'
        step.textContent = entry.step
        item.append(step)
      }
      if (entry.comment !== undefined) {
        const comment = document.createElement('p')
        comment.className = 'timeline-comment'
        comment.textContent = entry.comment
        item.append(comment)
      }
      if (entry.call !== undefined) {
        const call = document.createElement('span')
        call.className = 'timeline-call'
        call.textContent = `${entry.call.operation} ${entry.call.outcome} at ${new Date(entry.call.time).toISOString()}`
        item.append(call)
      }
      list.append(item)
    }
    return list
  }

  /**
   * Render one inbox tab (VT-1, VT-2, S14, AS-2). Each item is a link to the
   * task page; the state, the holder and the last activity tell the reader
   * whether nobody opened the task, who holds it and how long it sits there.
   * The empty state names the tab, so a blank list is never ambiguous.
   */
  const renderInbox = async (tab: string): Promise<void> => {
    const current = inboxTabOf(tab)
    const heading = document.createElement('h1')
    heading.textContent = 'Inbox'
    main.appendChild(heading)
    const tabs = document.createElement('nav')
    tabs.className = 'inbox-tabs'
    for (const entry of inboxTabs) {
      const link = document.createElement('a')
      link.href = `/?inbox=1&tab=${entry.key}`
      link.textContent = entry.label
      link.dataset.inboxTab = entry.key
      if (entry.key === current) link.setAttribute('aria-current', 'page')
      tabs.appendChild(link)
    }
    main.appendChild(tabs)

    const items = await readInbox(current)
    const label = inboxTabs.find((entry) => entry.key === current)?.label ?? current
    if (items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.dataset.inboxEmpty = current
      empty.textContent = `Nothing in ${label}.`
      main.appendChild(empty)
      return
    }
    const list = document.createElement('ul')
    list.className = 'inbox'
    for (const item of items) {
      const entry = document.createElement('li')
      entry.className = 'inbox-item'
      const link = document.createElement('a')
      link.href = `/?flow=${encodeURIComponent(item.flowSlug)}&instance=${encodeURIComponent(item.instanceId)}`
      link.dataset.inboxInstance = item.instanceId
      link.dataset.inboxState = item.state
      const flow = document.createElement('strong')
      flow.textContent = item.flowSlug
      const step = document.createElement('span')
      step.className = 'step'
      step.textContent = item.step
      const state = document.createElement('span')
      state.className = 'state'
      state.textContent = item.state
      link.append(flow, step, state)
      if (item.holder !== undefined) {
        const holder = document.createElement('span')
        holder.className = 'holder'
        holder.textContent = item.holder
        link.appendChild(holder)
      }
      if (item.dueAt !== undefined) {
        const due = document.createElement('time')
        due.className = 'due'
        due.dataset.inboxDue = ''
        due.dateTime = new Date(item.dueAt).toISOString()
        due.title = due.dateTime
        due.textContent = relativeDue(item.dueAt, clock())
        link.appendChild(due)
      }
      if (item.lastActivityAt !== undefined) {
        const activity = document.createElement('time')
        activity.className = 'activity'
        activity.dateTime = new Date(item.lastActivityAt).toISOString()
        activity.textContent = new Date(item.lastActivityAt).toISOString()
        link.appendChild(activity)
      }
      entry.appendChild(link)
      list.appendChild(entry)
    }
    main.appendChild(list)
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

  /**
   * Render the directory and the create form (ID-6, DE-1, ADR 0012). The read
   * and the write go through the generated client, so the server decides who
   * may see the directory and who may create a user (I8, I12). A created
   * user's temporary password is shown once, with the id that the builder's
   * target input uses (ID-4).
   */
  const renderUsers = async (): Promise<void> => {
    const heading = document.createElement('h1')
    heading.textContent = 'Users'
    main.appendChild(heading)

    let users: readonly DirectoryUser[]
    try {
      users = await listUsers()
    } catch (error: unknown) {
      const refusal = document.createElement('p')
      refusal.className = 'status'
      refusal.dataset.usersRefused = ''
      refusal.textContent = messageOf(error)
      main.appendChild(refusal)
      return
    }

    const list = document.createElement('ul')
    list.className = 'users'
    list.dataset.userList = ''
    main.appendChild(list)
    const renderList = (entries: readonly DirectoryUser[]): void => {
      list.replaceChildren()
      if (entries.length === 0) {
        const empty = document.createElement('li')
        empty.className = 'empty'
        empty.textContent = 'The directory holds no user yet.'
        list.appendChild(empty)
        return
      }
      for (const entry of entries) {
        const item = document.createElement('li')
        item.className = 'user'
        item.dataset.userRow = ''
        const name = document.createElement('strong')
        name.dataset.userName = ''
        name.textContent = entry.displayName
        const email = document.createElement('span')
        email.dataset.userEmailAddress = ''
        email.textContent = entry.email
        const id = document.createElement('code')
        id.dataset.userId = ''
        id.textContent = entry.id
        const status = document.createElement('span')
        status.dataset.userStatus = ''
        status.textContent = entry.status
        item.append(name, email, id, status)
        list.appendChild(item)
      }
    }
    renderList(users)

    const form = document.createElement('form')
    form.className = 'create-user'
    const emailLabel = document.createElement('label')
    emailLabel.textContent = 'Email'
    const email = document.createElement('input')
    email.type = 'email'
    email.name = 'email'
    email.dataset.userEmail = ''
    email.required = true
    emailLabel.appendChild(email)
    form.appendChild(emailLabel)

    const nameLabel = document.createElement('label')
    nameLabel.textContent = 'Display name'
    const displayName = document.createElement('input')
    displayName.type = 'text'
    displayName.name = 'displayName'
    displayName.dataset.userDisplayName = ''
    displayName.required = true
    nameLabel.appendChild(displayName)
    form.appendChild(nameLabel)

    const create = document.createElement('button')
    create.type = 'submit'
    create.textContent = 'Create user'
    create.dataset.createUser = ''
    form.appendChild(create)

    const status = document.createElement('p')
    status.className = 'status'
    form.appendChild(status)

    const created = document.createElement('section')
    created.className = 'created-user'
    form.appendChild(created)

    const submitCreateUser = async (): Promise<void> => {
      const address = email.value.trim()
      const name = displayName.value.trim()
      if (address === '' || name === '') return
      try {
        const user = await createUser({ email: address, displayName: name, sendInvite: false })
        status.textContent = `Created ${user.displayName}`
        showCreatedUser(created, user)
        email.value = ''
        displayName.value = ''
        try {
          renderList(await listUsers())
        } catch {
          // The created user is shown either way; the list refreshes on the
          // next visit.
        }
      } catch (error: unknown) {
        status.textContent = messageOf(error)
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void submitCreateUser()
    })
    main.appendChild(form)
  }

  /**
   * Render the directory groups and their members (ID-6, AS-1, #252). The read
   * and the write go through the generated client, so the server decides who
   * may see the directory (I8, I12). The id is the principal that a group
   * target names in the builder.
   */
  const renderGroups = async (): Promise<void> => {
    const heading = document.createElement('h1')
    heading.textContent = 'Groups'
    main.appendChild(heading)

    let groups: readonly DirectoryGroup[]
    try {
      groups = await listGroups()
    } catch (error: unknown) {
      const refusal = document.createElement('p')
      refusal.className = 'status'
      refusal.dataset.groupsRefused = ''
      refusal.textContent = messageOf(error)
      main.appendChild(refusal)
      return
    }

    const list = document.createElement('ul')
    list.className = 'groups'
    list.dataset.groupList = ''
    main.appendChild(list)
    if (groups.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'empty'
      empty.textContent = 'The directory holds no group yet.'
      list.appendChild(empty)
      return
    }
    for (const entry of groups) {
      const item = document.createElement('li')
      item.className = 'group'
      item.dataset.groupRow = entry.id
      const name = document.createElement('strong')
      name.dataset.groupName = ''
      name.textContent = entry.name
      const id = document.createElement('code')
      id.dataset.groupId = ''
      id.textContent = entry.id
      const members = document.createElement('ul')
      members.dataset.groupMembers = ''
      for (const member of entry.members) {
        const person = document.createElement('li')
        person.dataset.groupMember = member.id
        person.textContent = `${member.displayName} (${member.email})`
        members.appendChild(person)
      }
      item.append(name, id, members)
      list.appendChild(item)
    }
  }

  /**
   * Render the Unroutable queue (I10, AS-5, #252). The flow owner sees the
   * open tasks whose targets resolved to nobody; the server authorizes every
   * row, so a principal without `task.reassign` reads nothing (I8).
   */
  const renderUnroutable = async (): Promise<void> => {
    const heading = document.createElement('h1')
    heading.textContent = 'Unroutable'
    main.appendChild(heading)

    let items: readonly UnroutableItem[]
    try {
      items = await listUnroutable()
    } catch (error: unknown) {
      const refusal = document.createElement('p')
      refusal.className = 'status'
      refusal.dataset.unroutableRefused = ''
      refusal.textContent = messageOf(error)
      main.appendChild(refusal)
      return
    }

    const list = document.createElement('ul')
    list.className = 'unroutable'
    list.dataset.unroutableList = ''
    main.appendChild(list)
    if (items.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'empty'
      empty.textContent = 'No task waits in the Unroutable queue.'
      list.appendChild(empty)
      return
    }
    for (const item of items) {
      const entry = document.createElement('li')
      entry.dataset.unroutableItem = item.instanceId
      const link = document.createElement('a')
      link.href = `/?flow=${encodeURIComponent(item.flowSlug)}&instance=${encodeURIComponent(item.instanceId)}`
      link.textContent = `${item.flowSlug} ${item.step}`
      entry.appendChild(link)
      list.appendChild(entry)
    }
  }

  const renderRoute = async (): Promise<void> => {
    clearPage()
    if (options.users === true) {
      await renderUsers()
      return
    }
    if (options.groups === true) {
      await renderGroups()
      return
    }
    if (options.queue === true) {
      await renderUnroutable()
      return
    }
    if (options.inbox === true) {
      await renderInbox(options.inboxTab ?? 'my')
      return
    }
    if (options.changes === true) {
      await renderChanges()
      return
    }
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

  const renderBuilder = async (slug: string): Promise<void> => {
    await mountBuilder({ root: main, slug, actor, clock, ids })
  }

  try {
    await renderRoute()
  } catch (error: unknown) {
    main.textContent = messageOf(error)
  }
}

/** The three inbox tabs, in the order the page shows them (VT-1). */
const inboxTabs = [
  { key: 'my', label: 'My tasks' },
  { key: 'available', label: 'Available' },
  { key: 'started', label: 'Started by me' },
] as const

/** The tab the URL names, or `my` for an absent or unknown value (VT-1). */
function inboxTabOf(value: string): 'my' | 'available' | 'started' {
  return value === 'available' || value === 'started' ? value : 'my'
}

/**
 * Show the user the create call made, with the one-time temporary password
 * (ID-6, ADR 0012). The id is the principal that a builder target names
 * (ID-4). The password is shown once: a reload cannot show it again because
 * the server keeps no copy in enform.
 */
function showCreatedUser(host: HTMLElement, user: CreatedUser): void {
  host.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = `Created ${user.displayName}`
  const warning = document.createElement('p')
  warning.className = 'warning'
  warning.dataset.passwordOnce = ''
  warning.textContent =
    'This password is shown once. Copy it now and hand it to the user; it cannot be shown again.'

  const idLabel = document.createElement('p')
  idLabel.textContent = 'User id (the builder target)'
  const id = document.createElement('code')
  id.dataset.createdId = ''
  id.textContent = user.id
  idLabel.appendChild(id)

  const passwordLabel = document.createElement('p')
  passwordLabel.textContent = 'Temporary password'
  const password = document.createElement('code')
  password.dataset.createdPassword = ''
  password.textContent = user.temporaryPassword
  passwordLabel.appendChild(password)

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy password'
  copy.dataset.copyPassword = ''
  copy.addEventListener('click', () => {
    const clipboard = navigator.clipboard
    if (clipboard === undefined) {
      copy.disabled = true
      copy.textContent = 'Copy unavailable'
      return
    }
    void clipboard
      .writeText(user.temporaryPassword)
      .then(() => {
        copy.textContent = 'Copied'
      })
      .catch(() => {
        copy.textContent = 'Copy failed'
      })
  })

  host.append(heading, warning, idLabel, passwordLabel, copy)
}

/** The status line of an instance (VT-1, VT-2, S14): position, state and holder. */
function statusLine(status: InstanceView['status']): string {
  const holder = status.holder === undefined ? '' : `, holder ${status.holder}`
  return `Step ${status.step} of ${status.totalSteps}: ${status.state}${holder}`
}

/** The plain-language label of one tracker state (VT-2, S14). */
const TRACKER_STATES: Readonly<Record<string, string>> = {
  'not-reached': 'not reached',
  unopened: 'waiting to be opened',
  opened: 'opened',
  completed: 'completed',
  skipped: 'skipped',
  'sent-back': 'sent back',
}

/** The plain-language state that the tracker shows (VT-2, S14). */
function trackerLabel(state: string): string {
  return TRACKER_STATES[state] ?? state
}

/**
 * The relative label of a due time (VT-2, S14): how long remains until the
 * deadline, or how long it is past. The server read carries the absolute
 * `dueAt`; the page compares it with its own clock and keeps the absolute time
 * in the tooltip and the `datetime` attribute.
 */
function relativeDue(dueAt: number, now: number): string {
  const delta = dueAt - now
  const label = durationLabel(Math.abs(delta))
  return delta < 0 ? `overdue by ${label}` : `due in ${label}`
}

/** A coarse duration in plain words: seconds, minutes, hours or days. */
function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return durationUnit(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return durationUnit(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return durationUnit(hours, 'hour')
  return durationUnit(Math.round(hours / 24), 'day')
}

/** One duration unit with its singular or plural noun. */
function durationUnit(value: number, noun: string): string {
  const amount = Math.max(1, value)
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`
}

/** The plain-language label of one timeline event (S15, VT-5). */
const TIMELINE_TYPES: Readonly<Record<string, string>> = {
  'instance.started@1': 'started',
  'instance.submitted@1': 'submitted',
  'step.claimed@1': 'claimed',
  'step.completed@1': 'completed',
  'step.sent-back@1': 'sent back',
  'step.skipped@1': 'skipped',
  'step.taken-over@1': 'taken over',
  'instance.withdrawn@1': 'withdrawn',
  'instance.cancelled@1': 'cancelled',
  'instance.undone@1': 'undone',
  'connector.called@1': 'connector called',
  'config.definition.changed@1': 'definition changed',
  'config.definition.published@1': 'published',
  'config.flow.title@1': 'title changed',
  'config.grant.changed@1': 'grant changed',
  'config.team.changed@1': 'team changed',
  'config.connector.changed@1': 'connector changed',
  'config.template.changed@1': 'template changed',
}

/** The plain-language label of one timeline entry (S15, VT-5). */
function timelineLabel(type: string): string {
  return TIMELINE_TYPES[type] ?? type
}

/** The server's reason for a refusal, or the plain message of another error. */
function reasonOf(error: unknown): string {
  return error instanceof RequestRefused ? error.error : messageOf(error)
}

/** The wait before a takeover in plain language (S10, AS-3). */
function remainingLabel(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
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
