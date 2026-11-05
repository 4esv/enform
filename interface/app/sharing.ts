// Issue #264, S02, AC-1, AC-2, AC-3, AC-4, VT-6, I12, I14, ADR 0009: the
// sharing panel of the builder. It lists the grants of one flow as the
// scopes the engine stores, answers "Who can approve at the registrar step?"
// from those scopes, and adds or revokes a grant through one attributed
// `config.grant.changed@1` operation (AC-2, I14). A preset such as
// "Approver" is a name the panel knows: it expands to scopes when the grant
// is made, and only scopes reach the server (AC-3). The engine evaluates
// every grant (AC-1, A9); the panel shows the stored result. Every element
// is plain DOM (ADR 0009), and the panel reaches the API through the
// generated client only (I12).

import {
  appendOperation,
  type Grant,
  type Operation,
  readDraft,
  readFlowGrants,
} from '../client/client.js'
import { stepKeys } from './form.js'

/** The event type of a grant change (AC-2, I14). */
const GRANT_CHANGE_TYPE = 'config.grant.changed@1'

/** One named preset (AC-3): the scopes it expands to, and whether it applies to the flow or to a step. */
export type Preset = {
  readonly key: string
  readonly label: string
  readonly scopes: readonly string[]
  readonly on: 'flow' | 'step'
}

/** The scopes of the Editor preset; Builder adds `flow.build` to them (DF-5). */
const EDITOR_SCOPES = [
  'flow.edit',
  'flow.dryrun',
  'instance.read',
  'instance.timeline',
  'task.reassign',
] as const

/**
 * The presets the panel offers (AC-3, S02). They have no meaning in the
 * engine: a preset is the panel's shorthand for the scopes it lists.
 */
export const PRESETS: readonly Preset[] = [
  { key: 'starter', label: 'Starter', scopes: ['instance.start'], on: 'flow' },
  {
    key: 'approver',
    label: 'Approver',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    on: 'step',
  },
  { key: 'reviewer', label: 'Reviewer', scopes: ['step.outcome:send_back'], on: 'step' },
  { key: 'editor', label: 'Editor', scopes: EDITOR_SCOPES, on: 'flow' },
  { key: 'builder', label: 'Builder', scopes: ['flow.build', ...EDITOR_SCOPES], on: 'flow' },
  { key: 'viewer', label: 'Viewer', scopes: ['instance.read', 'instance.timeline'], on: 'flow' },
]

/** What the add form names: the principal, the step when any, and a preset or explicit scopes. */
export type GrantInput = {
  readonly slug: string
  readonly principal: string
  readonly step?: string
  readonly preset?: string
  readonly scopes?: string
}

/**
 * The grant an input makes (AC-3): the preset expanded to its scopes, or the
 * listed scopes, on the flow or on the step. A reason names what is missing.
 */
export function grantFor(input: GrantInput): Grant | { readonly error: string } {
  const principal = principalOf(input.principal)
  if (principal === '') {
    return { error: 'name a principal: a user id, group:<name> or team:<slug>' }
  }
  const step = input.step === undefined || input.step.trim() === '' ? undefined : input.step.trim()
  const preset = PRESETS.find((candidate) => candidate.key === input.preset)
  if (preset !== undefined) {
    if (preset.on === 'step' && step === undefined) {
      return { error: `the preset ${preset.label} applies to a step; choose one` }
    }
    return {
      principal,
      scopes: [...preset.scopes],
      resource: resourceOf(input.slug, preset.on === 'step' ? step : undefined),
    }
  }
  const scopes = splitList(input.scopes ?? '')
  if (scopes.length === 0) return { error: 'choose a preset or list the scopes' }
  return { principal, scopes, resource: resourceOf(input.slug, step) }
}

/** The resource of a grant: the flow, or one of its steps (MVP.md 5.6). */
export function resourceOf(slug: string, step?: string): string {
  return step === undefined ? `flow:${slug}` : `flow:${slug}/step:${step}`
}

/**
 * The principals that may choose one outcome at one step (AC-4): those that
 * hold `step.outcome:<outcome>` on the step, or on the flow, which covers
 * its steps (MVP.md 5.6). The answer keeps the grants' order.
 */
export function whoCan(
  grants: readonly Grant[],
  slug: string,
  step: string,
  outcome: string
): readonly string[] {
  const scope = `step.outcome:${outcome}`
  const resources = new Set([resourceOf(slug), resourceOf(slug, step)])
  const principals: string[] = []
  for (const grant of grants) {
    if (!resources.has(grant.resource) || !grant.scopes.includes(scope)) continue
    if (!principals.includes(grant.principal)) principals.push(grant.principal)
  }
  return principals
}

/** One grant in plain language: who holds which scopes on what. */
export function describeGrant(grant: Grant): string {
  return `${grant.principal} holds ${grant.scopes.join(', ')} on ${grant.resource}`
}

/**
 * A principal as typed, normalized to the id the engine stores (ID-4): a
 * user is its directory id, as the builder's targets name it, so a `user:`
 * prefix is dropped; a group is `group:<name>` and a team `team:<slug>`.
 */
export function principalOf(text: string): string {
  const trimmed = text.trim()
  return trimmed.startsWith('user:') ? trimmed.slice('user:'.length) : trimmed
}

/** The entries of a comma or space separated list, trimmed and non-empty. */
function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export interface SharingOptions {
  /** The element that receives the panel. */
  readonly root: HTMLElement
  readonly slug: string
  /** The signed-in principal that makes the grant (I14). */
  readonly actor: string
  readonly clock: () => number
  /** The operation ID source (I1). */
  readonly ids: () => string
}

/** The panel's state between renders. */
type SharingState = SharingOptions & {
  grants: readonly Grant[]
  steps: readonly string[]
}

/** Mount the sharing panel for one flow below the builder (S02). */
export async function mountSharing(options: SharingOptions): Promise<void> {
  const panel = document.createElement('section')
  panel.className = 'sharing'
  panel.dataset.sharing = ''
  const heading = document.createElement('h2')
  heading.textContent = 'Sharing'
  panel.appendChild(heading)
  options.root.appendChild(panel)
  let grants: readonly Grant[]
  let steps: readonly string[] = []
  try {
    grants = await readFlowGrants(options.slug)
    const draft = await readDraft(options.slug)
    steps = draft.definition === undefined ? [] : stepKeys(draft.definition)
  } catch (error: unknown) {
    const status = document.createElement('p')
    status.className = 'status'
    status.dataset.sharingStatus = ''
    status.textContent = messageOf(error)
    panel.appendChild(status)
    return
  }
  const state: SharingState = { ...options, grants, steps }
  render(state, panel)
}

/** Render the whole panel from its state. */
function render(state: SharingState, panel: HTMLElement): void {
  for (const node of [...panel.children]) {
    if (node.tagName !== 'H2') node.remove()
  }
  panel.append(renderList(state, panel), renderWhoCan(state), renderAdd(state, panel))
  const status = document.createElement('p')
  status.className = 'status'
  status.dataset.sharingStatus = ''
  panel.appendChild(status)
}

/** The stored grants, as scopes (AC-3), each with its revoke control. */
function renderList(state: SharingState, panel: HTMLElement): HTMLElement {
  const list = document.createElement('ul')
  list.dataset.grantList = ''
  if (state.grants.length === 0) {
    const empty = document.createElement('li')
    empty.textContent = 'Nobody holds a grant on this flow yet.'
    list.appendChild(empty)
  }
  for (const grant of state.grants) {
    const item = document.createElement('li')
    item.dataset.grant = ''
    item.dataset.grantPrincipal = grant.principal
    item.dataset.grantResource = grant.resource
    item.dataset.grantScopes = grant.scopes.join(' ')
    const text = document.createElement('span')
    text.textContent = describeGrant(grant)
    const revoke = document.createElement('button')
    revoke.type = 'button'
    revoke.textContent = 'Revoke'
    revoke.dataset.revoke = ''
    revoke.addEventListener('click', () => {
      void change(state, panel, grant, 'revoked')
    })
    item.append(text, ' ', revoke)
    list.appendChild(item)
  }
  return list
}

/** The question "Who can <outcome> at <step>?", answered from the stored grants (AC-4). */
function renderWhoCan(state: SharingState): HTMLElement {
  const form = document.createElement('form')
  form.className = 'who-can'
  const stepLabel = document.createElement('label')
  stepLabel.textContent = 'Who can '
  const outcome = document.createElement('input')
  outcome.name = 'outcome'
  outcome.placeholder = 'approve'
  outcome.dataset.whoOutcome = ''
  const atLabel = document.createElement('label')
  atLabel.textContent = ' at '
  const step = document.createElement('select')
  step.name = 'step'
  step.dataset.whoStep = ''
  for (const key of state.steps) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = key
    step.appendChild(option)
  }
  atLabel.appendChild(step)
  const ask = document.createElement('button')
  ask.type = 'submit'
  ask.textContent = 'Ask'
  ask.dataset.whoAsk = ''
  const answer = document.createElement('p')
  answer.dataset.whoAnswer = ''
  form.append(stepLabel, outcome, atLabel, ' ', ask, answer)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const who = whoCan(state.grants, state.slug, step.value, outcome.value.trim())
    answer.textContent =
      who.length === 0
        ? `Nobody can ${outcome.value.trim()} at ${step.value}.`
        : `${who.join(', ')} can ${outcome.value.trim()} at ${step.value}.`
  })
  return form
}

/** The add form: a principal, the flow or a step, and a preset or explicit scopes (AC-3). */
function renderAdd(state: SharingState, panel: HTMLElement): HTMLElement {
  const form = document.createElement('form')
  form.className = 'share'
  const principalLabel = document.createElement('label')
  principalLabel.textContent = 'Principal '
  const principal = document.createElement('input')
  principal.name = 'principal'
  principal.placeholder = '<user id>, group:<name> or team:<slug>'
  principal.dataset.sharePrincipal = ''
  principalLabel.appendChild(principal)
  const onLabel = document.createElement('label')
  onLabel.textContent = ' On '
  const resource = document.createElement('select')
  resource.name = 'resource'
  resource.dataset.shareResource = ''
  const flowOption = document.createElement('option')
  flowOption.value = ''
  flowOption.textContent = 'the whole flow'
  resource.appendChild(flowOption)
  for (const key of state.steps) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = `step ${key}`
    resource.appendChild(option)
  }
  onLabel.appendChild(resource)
  const presetLabel = document.createElement('label')
  presetLabel.textContent = ' Preset '
  const preset = document.createElement('select')
  preset.name = 'preset'
  preset.dataset.sharePreset = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'none: list the scopes'
  preset.appendChild(none)
  for (const candidate of PRESETS) {
    const option = document.createElement('option')
    option.value = candidate.key
    option.textContent = `${candidate.label} (${candidate.scopes.join(', ')})`
    preset.appendChild(option)
  }
  presetLabel.appendChild(preset)
  const scopesLabel = document.createElement('label')
  scopesLabel.textContent = ' Scopes '
  const scopes = document.createElement('input')
  scopes.name = 'scopes'
  scopes.placeholder = 'instance.read, instance.timeline'
  scopes.dataset.shareScopes = ''
  scopesLabel.appendChild(scopes)
  const add = document.createElement('button')
  add.type = 'submit'
  add.textContent = 'Add grant'
  add.dataset.shareAdd = ''
  form.append(principalLabel, onLabel, presetLabel, scopesLabel, ' ', add)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const grant = grantFor({
      slug: state.slug,
      principal: principal.value,
      ...(resource.value === '' ? {} : { step: resource.value }),
      ...(preset.value === '' ? {} : { preset: preset.value }),
      scopes: scopes.value,
    })
    if ('error' in grant) {
      statusOf(panel).textContent = grant.error
      return
    }
    void change(state, panel, grant, 'added')
  })
  return form
}

/** Post one grant change and re-read the stored grants (AC-2, I1, I14). */
async function change(
  state: SharingState,
  panel: HTMLElement,
  grant: Grant,
  kind: 'added' | 'revoked'
): Promise<void> {
  const operation: Operation = {
    id: state.ids(),
    type: GRANT_CHANGE_TYPE,
    at: state.clock(),
    actor: state.actor,
    payload: {
      principal: grant.principal,
      scopes: [...grant.scopes],
      resource: grant.resource,
      ...(kind === 'revoked' ? { change: 'revoked' } : {}),
    },
  }
  try {
    await appendOperation(operation)
    state.grants = await readFlowGrants(state.slug)
    render(state, panel)
    statusOf(panel).textContent =
      kind === 'added'
        ? `Granted ${grant.scopes.join(', ')} to ${grant.principal} on ${grant.resource}`
        : `Revoked ${grant.scopes.join(', ')} from ${grant.principal} on ${grant.resource}`
  } catch (error: unknown) {
    statusOf(panel).textContent = messageOf(error)
  }
}

function statusOf(panel: HTMLElement): HTMLElement {
  const status = panel.querySelector<HTMLElement>('[data-sharing-status]')
  if (status !== null) return status
  const created = document.createElement('p')
  created.className = 'status'
  created.dataset.sharingStatus = ''
  panel.appendChild(created)
  return created
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
