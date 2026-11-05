import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type FlowDefinition, parse, serialize } from '../engine/definition.js'
import { classifyChange } from '../engine/edit.js'
import { versionDiff } from '../engine/version.js'
import {
  createFlow,
  publishFlow,
  RequestRefused,
  readDraft,
  readFlow,
  readFlowGrants,
  readInbox,
  readInstanceTimeline,
  readLog,
} from '../interface/client/client.js'
import { type Args, flag, has, optionalFlag, report, required } from './args.js'
import {
  credentialsPath,
  deviceLogin,
  passwordLogin,
  rememberServer,
  removeCredential,
  writeCredential,
} from './login.js'
import { currentInstance, openSession, postIntent, type RemoteSession, serverOf } from './remote.js'

// Issue #258, DX-3, I12, ADR 0010: the command groups that work against the
// server. `login` and `logout` keep the credential; `flow` pushes, pulls,
// publishes and diffs through the flow API; `grant`, `instance`, `task`,
// `undo` and `log` post the client intents of STORIES.md and read the public
// reads. Each command reads what it needs from the server, posts one intent
// and reports what the server answered. The engine decides everything
// (A9): the CLI holds no state transition and no authorization.

/** The usage of a command group, as the error of a missing argument names it. */
const USAGE = {
  login: 'login [--server <url>] [--username <name> --password <secret>]',
  grantAdd: 'grant add <principal> <scope[,scope]> <resource>',
  grantList: 'grant list <resource>',
  grantRevoke: 'grant revoke <principal> <scope[,scope]> <resource>',
  instanceStart: 'instance start <slug> --data <file>',
  instanceEdit: 'instance edit <id> --data <file>',
  instanceSubmit: 'instance submit <id> [--data <file>]',
  instanceShow: 'instance show <id>',
  instanceTimeline: 'instance timeline <id> [--with-changes]',
  instanceWithdraw: 'instance withdraw <id> --reason <text>',
  instanceCancel: 'instance cancel <id> --reason <text>',
  instanceUndo: 'instance undo <id>',
  taskList: 'task list [--available | --mine | --started]',
  taskShow: 'task show <id>',
  taskClaim: 'task claim <id>',
  taskComplete:
    'task complete <id> --outcome <outcome> [--data <file>] [--comment <text>] [--to <step>]',
  taskTakeover: 'task takeover <id> --reason <text>',
  taskRelease: 'task release <id> [--reason <text>]',
  taskReassign: 'task reassign <id> --to <principal> --reason <text>',
  undo: 'undo <event-seq> --instance <id> --reason <text>',
  log: 'log [--instance <id>] [--limit <n>]',
  flowPull: 'flow pull <slug>',
  flowPush: 'flow push <file>',
  flowPublish: 'flow publish <slug>',
  flowDiff: 'flow diff <slug> --from <v|draft> --to <v|draft>',
} as const

/** The canonical definition file suffix (DF-1). */
const FILE_SUFFIX = '.flow.json'

/** The server of a command that needs one, or the message that says how to sign in. */
function requireServer(args: Args, env: NodeJS.ProcessEnv): string {
  const server = serverOf(args.flags, env)
  if (server === undefined) {
    throw new Error('no server: run enform login --server <url>, or set ENFORM_SERVER')
  }
  return server
}

/** Sign in (S01, ID-6): the device flow, or a username and a password when both are given. */
export async function runLogin(args: Args, json: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const server = requireServer(args, env)
  const username = optionalFlag(args, '--username')
  const password = optionalFlag(args, '--password')
  if ((username === undefined) !== (password === undefined)) {
    throw new Error(`a scripted sign-in needs both: usage is ${USAGE.login}`)
  }
  const now = () => Date.now()
  const credential =
    username !== undefined && password !== undefined
      ? await passwordLogin({ server, username, password, fetch, now })
      : await deviceLogin({
          server,
          fetch,
          now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          write: (line) => process.stderr.write(`${line}\n`),
        })
  const path = credentialsPath(env)
  writeCredential(path, server, credential)
  rememberServer(path, server)
  const session = await openSession(server, env)
  report(
    json,
    { ok: true, server, principal: session.principal },
    `signed in to ${server} as ${session.principal.displayName} (${session.principal.id})`
  )
  return 0
}

/** Forget the credential of the server (ADR 0012). */
export function runLogout(args: Args, json: boolean, env: NodeJS.ProcessEnv): number {
  const server = requireServer(args, env)
  removeCredential(credentialsPath(env), server)
  report(json, { ok: true, server }, `signed out of ${server}`)
  return 0
}

/** Open the session of the server a command names. */
async function session(args: Args, env: NodeJS.ProcessEnv): Promise<RemoteSession> {
  return openSession(requireServer(args, env), env)
}

/** The scopes of a grant command: a comma-separated list. */
function scopesOf(value: string): readonly string[] {
  const scopes = value
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '')
  if (scopes.length === 0) throw new Error('a grant needs at least one scope')
  return scopes
}

/** The slug of a flow resource (`flow:<slug>` or `flow:<slug>/step:<key>`), for the grants read. */
function flowOfResource(resource: string): string {
  const match = /^flow:([^/]+)(?:\/step:[^/]+)?$/.exec(resource)
  if (match === null) {
    throw new Error(
      `grant list reads the grants of a flow: the resource is flow:<slug> or flow:<slug>/step:<key>`
    )
  }
  return match[1]
}

/** The `grant` group (S02, AC-1, AC-2): add, list and revoke through the grant intent and the grants read. */
export async function runGrantGroup(
  action: string | undefined,
  args: Args,
  json: boolean,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const [, , principal, scopes, resource] = args.positionals
  if (action === 'list') {
    const target = required(principal, USAGE.grantList)
    await session(args, env)
    const grants = (await readFlowGrants(flowOfResource(target))).filter(
      (grant) => grant.resource === target || !target.includes('/step:')
    )
    report(
      json,
      { ok: true, resource: target, grants },
      grants
        .map((grant) => `${grant.principal}  ${grant.scopes.join(',')}  ${grant.resource}`)
        .join('\n') || 'no grants'
    )
    return 0
  }
  if (action === 'add' || action === 'revoke') {
    const usage = action === 'add' ? USAGE.grantAdd : USAGE.grantRevoke
    const who = required(principal, usage)
    const which = scopesOf(required(scopes, usage))
    const where = required(resource, usage)
    const current = await session(args, env)
    const event = await postIntent(current, 'config.grant.changed@1', {
      principal: who,
      scopes: which,
      resource: where,
      change: action === 'add' ? 'added' : 'revoked',
    })
    report(
      json,
      { ok: true, event },
      `${action === 'add' ? 'granted' : 'revoked'} ${which.join(',')} ${action === 'add' ? 'to' : 'from'} ${who} on ${where}`
    )
    return 0
  }
  throw new Error(`unknown grant command: ${action ?? ''}`.trim())
}

/** Read a JSON object file: the values of a form (FM-7). */
function readValues(cwd: string, file: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(resolve(cwd, file), 'utf8'))
  } catch {
    throw new Error(`${file} is not a JSON file`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file} must hold a JSON object of field values`)
  }
  return value as Record<string, unknown>
}

/** The plain-language lines of an instance (VT-1, VT-2, S14). */
function instanceText(view: Awaited<ReturnType<typeof currentInstance>>): string {
  const status = view.status
  const lines = [
    `instance ${view.instanceId}: ${status.state}` +
      (status.currentStep === undefined
        ? ''
        : `; step ${status.step} of ${status.totalSteps}: ${status.currentStep}`) +
      (status.holder === undefined ? '' : `; holder: ${status.holder}`),
  ]
  for (const step of view.tracker) {
    const detail = [
      step.holder === undefined ? '' : `holder ${step.holder}`,
      step.comment === undefined ? '' : `"${step.comment}"`,
      step.condition === undefined ? '' : JSON.stringify(step.condition),
    ]
      .filter((part) => part !== '')
      .join(', ')
    lines.push(`  ${step.key}: ${step.state}${detail === '' ? '' : ` (${detail})`}`)
  }
  return lines.join('\n')
}

/** The `instance` group (S06, S13, S14, S15): the starter's and the owner's commands. */
export async function runInstanceGroup(
  action: string | undefined,
  name: string | undefined,
  args: Args,
  json: boolean,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<number> {
  if (action === 'start') {
    const slug = required(name, USAGE.instanceStart)
    const values = readValues(cwd, flag(args, '--data', USAGE.instanceStart))
    const current = await session(args, env)
    const instanceId = (await import('./remote.js')).operationId()
    const event = await postIntent(current, 'instance.started@1', {
      flow: slug,
      instanceId,
      values,
    })
    report(json, { ok: true, instanceId, event }, `started ${instanceId} (draft)`)
    return 0
  }
  const instanceId = required(name, `instance ${action ?? '<command>'} <id>`)
  if (action === 'show') {
    await session(args, env)
    const view = await currentInstance(instanceId)
    report(json, { ok: true, instance: view }, instanceText(view))
    return 0
  }
  if (action === 'timeline') {
    await session(args, env)
    const entries = await readInstanceTimeline(
      instanceId,
      has(args, '--with-changes') ? 'true' : undefined
    )
    report(
      json,
      { ok: true, instanceId, entries },
      entries
        .map(
          (entry) =>
            `${entry.seq}  ${new Date(entry.at).toISOString()}  ${entry.actor ?? 'system'}  ${entry.type}` +
            (entry.step === undefined ? '' : `  ${entry.step}`) +
            (entry.comment === undefined ? '' : `  "${entry.comment}"`)
        )
        .join('\n') || 'no events'
    )
    return 0
  }
  const current = await session(args, env)
  if (action === 'edit') {
    const values = readValues(cwd, flag(args, '--data', USAGE.instanceEdit))
    const event = await postIntent(current, 'draft.edited@1', { instanceId, values })
    report(json, { ok: true, event }, `edited ${instanceId}`)
    return 0
  }
  const view = await currentInstance(instanceId)
  if (action === 'submit') {
    const dataFile = optionalFlag(args, '--data')
    const values = dataFile === undefined ? {} : readValues(cwd, dataFile)
    const event = await postIntent(current, 'instance.submitted@1', {
      instanceId,
      version: view.version,
      values,
    })
    report(
      json,
      { ok: true, event },
      `submitted ${instanceId}: step ${String(event.payload.currentStep ?? '')}`
    )
    return 0
  }
  if (action === 'withdraw' || action === 'cancel') {
    const usage = action === 'withdraw' ? USAGE.instanceWithdraw : USAGE.instanceCancel
    const reason = flag(args, '--reason', usage)
    const event = await postIntent(
      current,
      action === 'withdraw' ? 'instance.withdrawn@1' : 'instance.cancelled@1',
      { instanceId, reason, version: view.version }
    )
    report(
      json,
      { ok: true, event },
      `${action === 'withdraw' ? 'withdrew' : 'cancelled'} ${instanceId}`
    )
    return 0
  }
  if (action === 'undo') {
    const event = await postIntent(current, 'instance.undone@1', {
      instanceId,
      version: view.version,
    })
    report(json, { ok: true, event }, `undid the close of ${instanceId}`)
    return 0
  }
  throw new Error(`unknown instance command: ${action ?? ''}`.trim())
}

/** The inbox tab of `task list`: `--mine` by default (S09, VT-1). */
function tabOf(args: Args): string {
  const chosen = ['--available', '--mine', '--started'].filter((key) => has(args, key))
  if (chosen.length > 1) throw new Error(`choose one tab: usage is ${USAGE.taskList}`)
  if (chosen[0] === '--available') return 'available'
  if (chosen[0] === '--started') return 'started'
  return 'my'
}

/** The `task` group (S09, S10, S11): the assignee's and the holder's commands. */
export async function runTaskGroup(
  action: string | undefined,
  name: string | undefined,
  args: Args,
  json: boolean,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<number> {
  if (action === 'list') {
    await session(args, env)
    const tab = tabOf(args)
    const items = await readInbox(tab)
    report(
      json,
      { ok: true, tab, items },
      items
        .map(
          (item) =>
            `${item.instanceId}  ${item.flowSlug}  ${item.step}  ${item.state}` +
            (item.holder === undefined ? '' : `  ${item.holder}`)
        )
        .join('\n') || 'no tasks'
    )
    return 0
  }
  const instanceId = required(name, `task ${action ?? '<command>'} <id>`)
  const current = await session(args, env)
  const view = await currentInstance(instanceId)
  if (action === 'show') {
    report(json, { ok: true, instance: view }, instanceText(view))
    return 0
  }
  if (action === 'claim') {
    const event = await postIntent(current, 'step.claimed@1', {
      instanceId,
      expectedVersion: view.version,
    })
    report(
      json,
      { ok: true, event },
      `claimed ${instanceId} at ${String(event.payload.step ?? '')}`
    )
    return 0
  }
  if (action === 'complete') {
    const outcome = flag(args, '--outcome', USAGE.taskComplete)
    const to = optionalFlag(args, '--to')
    const comment = optionalFlag(args, '--comment')
    if (to !== undefined) {
      // A send back names the step it returns to and carries the note (S11, WF-3).
      const event = await postIntent(current, 'step.sent-back@1', {
        instanceId,
        to,
        ...(comment === undefined ? {} : { comment }),
        version: view.version,
      })
      report(json, { ok: true, event }, `sent ${instanceId} back to ${to}`)
      return 0
    }
    const dataFile = optionalFlag(args, '--data')
    const values = dataFile === undefined ? {} : readValues(cwd, dataFile)
    const event = await postIntent(current, 'step.completed@1', {
      instanceId,
      version: view.version,
      outcome,
      values: comment === undefined ? values : { ...values, comment },
    })
    report(json, { ok: true, event }, `completed ${instanceId} with ${outcome}`)
    return 0
  }
  if (action === 'takeover') {
    const reason = flag(args, '--reason', USAGE.taskTakeover)
    const event = await postIntent(current, 'step.taken-over@1', {
      instanceId,
      reason,
      version: view.version,
    })
    report(json, { ok: true, event }, `took over ${instanceId}`)
    return 0
  }
  if (action === 'release') {
    const reason = optionalFlag(args, '--reason')
    const event = await postIntent(current, 'task.released@1', {
      instanceId,
      version: view.version,
      ...(reason === undefined ? {} : { reason }),
    })
    report(json, { ok: true, event }, `released ${instanceId}`)
    return 0
  }
  if (action === 'reassign') {
    const to = flag(args, '--to', USAGE.taskReassign)
    const reason = flag(args, '--reason', USAGE.taskReassign)
    const event = await postIntent(current, 'task.reassigned@1', {
      instanceId,
      version: view.version,
      to,
      reason,
    })
    report(json, { ok: true, event }, `reassigned ${instanceId} to ${to}`)
    return 0
  }
  throw new Error(`unknown task command: ${action ?? ''}`.trim())
}

/** `undo <event-seq> --instance <id> --reason <text>` (S16, WF-5): the compensating event. */
export async function runUndo(
  name: string | undefined,
  args: Args,
  json: boolean,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const seq = Number(required(name, USAGE.undo))
  if (!Number.isInteger(seq) || seq < 1)
    throw new Error(`the event seq must be a positive integer: usage is ${USAGE.undo}`)
  const instanceId = flag(args, '--instance', USAGE.undo)
  const reason = flag(args, '--reason', USAGE.undo)
  const current = await session(args, env)
  const view = await currentInstance(instanceId)
  const event = await postIntent(current, 'event.undone@1', {
    instanceId,
    eventId: seq,
    reason,
    version: view.version,
  })
  report(json, { ok: true, event }, `undid event ${seq} of ${instanceId}`)
  return 0
}

/** `log [--instance <id>] [--limit <n>]` (S16, DX-3, I8): the events the person may read. */
export async function runLog(args: Args, json: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const instanceId = optionalFlag(args, '--instance')
  const limitValue = optionalFlag(args, '--limit')
  const limit = limitValue === undefined ? undefined : Number(limitValue)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`the limit must be a non-negative integer: usage is ${USAGE.log}`)
  }
  await session(args, env)
  const log = await readLog(instanceId, limit)
  report(
    json,
    { ok: true, log },
    log
      .map(
        (event) =>
          `${event.seq}  ${new Date(event.at).toISOString()}  ${event.actor ?? 'system'}  ${event.type}` +
          (typeof event.payload.instanceId === 'string' ? `  ${event.payload.instanceId}` : '')
      )
      .join('\n') || 'no events'
  )
  return 0
}

/** The slug of a definition file: its base name without the canonical suffix (DF-4). */
function slugOfFile(file: string): string {
  const base = file.split('/').pop() ?? file
  if (!base.endsWith(FILE_SUFFIX))
    throw new Error(`flow file: ${base} must end with ${FILE_SUFFIX}`)
  return base.slice(0, -FILE_SUFFIX.length)
}

/** The definition of a draft read, or an error when the draft is still empty (DF-4). */
function draftDefinition(
  draft: { readonly definition?: Record<string, unknown> },
  slug: string
): FlowDefinition {
  if (draft.definition === undefined)
    throw new Error(`the draft of ${slug} is empty; push a definition first`)
  return parse(JSON.stringify(draft.definition))
}

/** One side of a remote diff: a published version or the draft (DF-6). */
async function remoteSide(
  slug: string,
  ref: string
): Promise<{
  definition: FlowDefinition
  version?: { version: number; contentHash: string; definition: FlowDefinition }
}> {
  if (ref === 'draft') return { definition: draftDefinition(await readDraft(slug), slug) }
  const number = Number(ref)
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`flow diff: a side is a version number or draft, not ${ref}`)
  const published = await readFlow(slug, number)
  const definition = parse(JSON.stringify(published.definition))
  return {
    definition,
    version: { version: published.version, contentHash: published.contentHash, definition },
  }
}

/**
 * The `flow` commands that go to the server once signed in (S01, S03, DF-2,
 * DF-4, DF-6): pull writes the draft as the canonical file, push writes the
 * file to the draft (creating the flow on its first push), publish freezes
 * the draft, and diff names the differences between two sides.
 */
export async function runRemoteFlow(
  action: string,
  name: string | undefined,
  args: Args,
  json: boolean,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<number> {
  await session(args, env)
  if (action === 'pull') {
    const slug = required(name, USAGE.flowPull)
    const draft = await readDraft(slug)
    const file = `${slug}${FILE_SUFFIX}`
    writeFileSync(join(cwd, file), serialize(draftDefinition(draft, slug)))
    report(
      json,
      { ok: true, slug, version: draft.version, path: file },
      `wrote ${file} (draft version ${draft.version})`
    )
    return 0
  }
  if (action === 'push') {
    const file = required(name, USAGE.flowPush)
    const slug = slugOfFile(file)
    const definition = parse(readFileSync(resolve(cwd, file), 'utf8'))
    let draft: { readonly version: number }
    try {
      draft = await readDraft(slug)
    } catch (error) {
      if (!(error instanceof RequestRefused) || error.status !== 404) throw error
      draft = await createFlow({ slug })
    }
    const written = await (await import('../interface/client/client.js')).writeDraft(
      {
        version: draft.version,
        definition: JSON.parse(serialize(definition)) as Record<string, unknown>,
      },
      slug
    )
    const changes = written.changes ?? []
    report(
      json,
      { ok: true, slug, path: file, version: written.version, changes },
      `pushed ${file} (draft version ${written.version}, ${changes.length} change${changes.length === 1 ? '' : 's'})`
    )
    return 0
  }
  if (action === 'publish') {
    const slug = required(name, USAGE.flowPublish)
    const draft = await readDraft(slug)
    const published = await publishFlow({ version: draft.version }, slug)
    report(
      json,
      { ok: true, slug, version: published.version, contentHash: published.contentHash },
      `published ${slug} v${published.version} ${published.contentHash}`
    )
    return 0
  }
  if (action === 'diff') {
    const slug = required(name, USAGE.flowDiff)
    const from = flag(args, '--from', USAGE.flowDiff)
    const to = flag(args, '--to', USAGE.flowDiff)
    const previous = await remoteSide(slug, from)
    const next = await remoteSide(slug, to)
    const changes =
      previous.version !== undefined && next.version !== undefined
        ? versionDiff(previous.version, next.version)
        : classifyChange(previous.definition, next.definition)
    report(
      json,
      { ok: true, slug, from, to, changes },
      changes.length === 0
        ? 'no differences'
        : changes.map((change) => `${change.class}: ${change.message}`).join('\n')
    )
    return 0
  }
  throw new Error(`unknown flow command: ${action}`)
}
