// Issue #38, S01, DF-1, DF-2, DF-4, DF-6, DX-3, I6, I7, I9, I14: the `enform`
// command. The command groups are `login`, `flow`, `grant`, `instance`, `task`,
// `undo` and `log` (cli/README.md); this unit covers the `flow` commands:
// `init`, `validate`, `pull`, `push`, `publish`, `diff` and `dry-run`. The CLI
// is file-backed and in-process: it imports the engine and the local
// `.enform/` store, and it never uses a server or the network. The CLI holds
// no correctness logic (A9); it parses the arguments, calls the engine,
// persists the result and reports. Every command accepts `--json`. The command
// names, flags, exit codes and `--json` output are a public surface (MVP.md
// 9.1), so the shapes below change only with that surface. The CLI is
// deterministic (I6).

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse, serialize } from '../engine/definition.js'
import { classifyChange, type DefinitionChange } from '../engine/edit.js'
import {
  type Flow,
  type FlowVersion,
  publish,
  push,
  STARTER_DEFINITION,
  validate,
} from '../engine/flow.js'
import type { ActorId, OperationDeps } from '../engine/operation.js'
import type { RunSources } from '../engine/run.js'
import { versionDiff } from '../engine/version.js'
import { runFlow } from '../engine/workflow.js'
import { bootstrap } from '../server/bootstrap.js'
import { configPath, issuerUrl, loadConfig, writeConfig } from '../server/config.js'
import { newEncryptionKey, validEncryptionKey } from '../server/crypto.js'
import {
  createDatabaseIfMissing,
  createPool,
  exportStore,
  importStore,
  migrationStatus,
  rebuild,
  runMigrations,
  type StoreBackup,
} from '../server/db.js'
import { serveHttp } from '../server/http.js'
import { oidcConfiguration } from '../server/keycloak.js'
import { checkMail } from '../server/mail.js'
import { clearDemo, seedDemo } from '../server/seed.js'
import { syncDirectory } from '../server/sync.js'
import { VERSION, versionLine } from '../server/version.js'
import { startWorker } from '../server/worker.js'
import { type Args, flag, has, parseArgs, report, required } from './args.js'
import {
  runAdminDeprovision,
  runGrantGroup,
  runInstanceGroup,
  runLog,
  runLogin,
  runLogout,
  runRemoteFlow,
  runTaskGroup,
  runUndo,
} from './groups.js'
import { serverOf } from './remote.js'
import { readFlow, writeFlow } from './store.js'

/** The canonical extension of a flow definition file (DF-4). */
const FILE_SUFFIX = '.flow.json'

/**
 * The principal that the local CLI acts as (I14). The CLI is file-backed and
 * in-process, and the `login` group arrives in a later unit, so a command that
 * must attribute a change uses one local principal (MVP.md, DX-3). The actor
 * does not change the persisted flow.
 */
const LOCAL_PRINCIPAL: ActorId = 'cli'

/**
 * The injected sources for a command that records an operation (I6): the clock
 * and the operation ID generator are fixed, so a command reads no system clock
 * and is deterministic. The CLI persists the flow, not the log, so the
 * operation that the engine returns is discarded.
 */
const CLI_DEPS: OperationDeps = { clock: () => 0, ids: () => 'cli' }

/**
 * The injected sources of a dry run (I7): the dry sink commits no operation
 * (A6), so the run writes no event and reads neither injected source.
 */
const DRY_SOURCES: RunSources = { clock: () => 0, ids: () => '', sink: 'dry' }

/**
 * Run one `enform` command line synchronously and return its exit code. The
 * result goes to stdout, an error to stderr; success is 0 and every error is 1
 * (MVP.md 9.1). This entry point serves the synchronous commands (`version`,
 * `help` and the `flow` group); an asynchronous command is refused rather than
 * reporting an exit code before the command finished. `runCli` is the bin's
 * entry point and awaits every command.
 */
export function main(argv: readonly string[]): number {
  const json = argv.includes('--json')
  const args = argv.filter((arg) => arg !== '--json')
  try {
    const result = run(args, json, process.cwd())
    if (typeof result !== 'number') {
      throw new Error(
        `${args[0] ?? 'this command'} runs asynchronously; run it through the enform bin`
      )
    }
    return result
  } catch (error) {
    return fail(error, json)
  }
}

/** Run one `enform` command line and await it: the `enform` bin entry point. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const json = argv.includes('--json')
  const args = argv.filter((arg) => arg !== '--json')
  try {
    return await run(args, json, process.cwd())
  } catch (error) {
    return fail(error, json)
  }
}

/** Write one failure and return the exit code (MVP.md 9.1). */
function fail(error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error)
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  else process.stderr.write(`enform: ${message}\n`)
  return 1
}

/**
 * Dispatch the command line to one command, or refuse an unknown group or
 * action. The positionals name the group, the action and the subject; the
 * flags carry the values that are not positional.
 */
function run(argv: readonly string[], json: boolean, cwd: string): number | Promise<number> {
  const args = parseArgs(argv)
  const [group, action, name] = args.positionals
  if (group === undefined || group === 'help') {
    printHelp()
    return 0
  }
  if (group === 'version') {
    process.stdout.write(`${versionLine()}\n`)
    return 0
  }
  if (group === 'flow') return runFlowGroup(action, name, args, json, cwd)
  if (group === 'login') return runLogin(args, json, process.env)
  if (group === 'logout') return runLogout(args, json, process.env)
  if (group === 'grant') return runGrantGroup(action, args, json, process.env)
  if (group === 'instance') return runInstanceGroup(action, name, args, json, process.env, cwd)
  if (group === 'task') return runTaskGroup(action, name, args, json, process.env, cwd)
  if (group === 'undo') return runUndo(action, args, json, process.env)
  if (group === 'log') return runLog(args, json, process.env)
  if (SERVICE_COMMANDS.has(group)) return runServiceCommand(group, action, args, json)
  throw new Error(`unknown command group: ${group}`.trim())
}

/** The `flow` commands that a signed-in person runs against the server (#258). */
const REMOTE_FLOW_COMMANDS = new Set(['pull', 'push', 'publish', 'diff', 'dry-run'])

/** The service commands that ADR 0011 gives the one `enform` binary. */
const SERVICE_COMMANDS = new Set(['init', 'serve', 'migrate', 'worker', 'admin', 'seed', 'doctor'])

/** Dispatch the `flow` group, which is synchronous and file-backed. */
function runFlowGroup(
  action: string | undefined,
  name: string | undefined,
  args: Args,
  json: boolean,
  cwd: string
): number | Promise<number> {
  // Once a server is configured (`--server`, ENFORM_SERVER or the last
  // sign-in), the draft and the versions live there (#258, S01, DF-4);
  // without one the local `.enform/` store serves an offline session.
  if (action !== undefined && REMOTE_FLOW_COMMANDS.has(action)) {
    const server = serverOf(args.flags, process.env)
    if (server !== undefined) return runRemoteFlow(action, name, args, json, process.env, cwd)
  }
  if (action === 'init') return flowInit(name, json, cwd)
  if (action === 'validate') return flowValidate(name, json, cwd)
  if (action === 'pull') return flowPull(name, json, cwd)
  if (action === 'push') return flowPush(name, json, cwd)
  if (action === 'publish') return flowPublish(name, json, cwd)
  if (action === 'diff') return flowDiff(name, args, json, cwd)
  if (action === 'dry-run') return flowDryRun(name, args, json, cwd)
  throw new Error(`unknown flow command: ${action ?? ''}`.trim())
}

/**
 * `flow init <slug>`: write the canonical definition file for a new draft
 * (DF-1). The engine serializes the definition, so the file is canonical.
 */
function flowInit(name: string | undefined, json: boolean, cwd: string): number {
  const slug = required(name, 'flow init <slug>')
  const file = `${slug}${FILE_SUFFIX}`
  writeFileSync(join(cwd, file), serialize(STARTER_DEFINITION))
  report(json, { ok: true, slug, path: file }, `wrote ${file}`)
  return 0
}

/**
 * `flow validate <file>`: parse the file and report the error when it is
 * invalid (DF-1). The command reads and changes nothing.
 */
function flowValidate(name: string | undefined, json: boolean, cwd: string): number {
  const file = required(name, 'flow validate <file>')
  validate(readFileSync(join(cwd, file), 'utf8'))
  report(json, { ok: true, path: file }, `valid: ${file}`)
  return 0
}

/**
 * `flow pull <slug>`: write the canonical definition file for a flow (DF-4).
 * Unit 1 is file-backed, so the local file is the draft store; the command
 * reads it, parses it and writes the canonical form, which equals the file
 * byte for byte when the file is already canonical (I9).
 */
function flowPull(name: string | undefined, json: boolean, cwd: string): number {
  const slug = required(name, 'flow pull <slug>')
  const file = `${slug}${FILE_SUFFIX}`
  const path = join(cwd, file)
  writeFileSync(path, serialize(parse(readFileSync(path, 'utf8'))))
  report(json, { ok: true, slug, path: file }, `wrote ${file}`)
  return 0
}

/**
 * `flow push <file>`: apply the definition file to the flow's draft (DF-4,
 * I14). The engine records the change against the stored flow and returns the
 * new flow; the command persists it. The draft becomes the pushed file, so a
 * `pull` reproduces it byte for byte (I9).
 */
function flowPush(name: string | undefined, json: boolean, cwd: string): number {
  const file = required(name, 'flow push <file>')
  const slug = slugOf(file)
  const definition = parse(readFileSync(join(cwd, file), 'utf8'))
  const flow = readFlow(slug, cwd)
  const pushed = push(flow, definition, CLI_DEPS, LOCAL_PRINCIPAL)
  writeFlow(slug, pushed.flow, cwd)
  report(json, { ok: true, slug, path: file }, `pushed ${file}`)
  return 0
}

/**
 * `flow publish <slug>`: freeze the draft into the next immutable version
 * (DF-2). The engine adds the version with its content hash and returns the
 * new flow; the command persists it and reports the version and the hash. The
 * published version never changes, so an instance stays on it (I13).
 */
function flowPublish(name: string | undefined, json: boolean, cwd: string): number {
  const slug = required(name, 'flow publish <slug>')
  const flow = readFlow(slug, cwd)
  const published = publish(flow, CLI_DEPS, LOCAL_PRINCIPAL)
  writeFlow(slug, published.flow, cwd)
  const version = published.flow.versions[published.flow.versions.length - 1]
  const hash = version.contentHash
  const text = `published ${slug} v${version.version} ${hash}`
  report(json, { ok: true, slug, version: version.version, contentHash: hash }, text)
  return 0
}

/**
 * `flow diff <slug> --from <v> --to <v|draft>`: name the difference between
 * two sides of a flow (DF-6). A side is a version number or `draft`. Two
 * published versions use the engine's version diff; a side that is the draft
 * uses the same classification on the draft definition. An empty list means
 * the two sides are equal.
 */
function flowDiff(name: string | undefined, args: Args, json: boolean, cwd: string): number {
  const usage = 'flow diff <slug> --from <v> --to <v|draft>'
  const slug = required(name, usage)
  const from = flag(args, '--from', usage)
  const to = flag(args, '--to', usage)
  const flow = readFlow(slug, cwd)
  const changes = diffChanges(flow, from, to)
  const text =
    changes.length === 0
      ? 'no differences'
      : changes.map((change) => `${change.class}: ${change.message}`).join('\n')
  report(json, { ok: true, slug, from, to, changes }, text)
  return 0
}

/**
 * `flow dry-run <slug> --data <file> --as <principal>`: run the draft as a dry
 * run (DR-1, I7). The run reads the definition and the data file, decides the
 * route and prints the side-effect intents. The dry sink commits no operation
 * (A6), so the run writes no event and changes nothing.
 */
function flowDryRun(name: string | undefined, args: Args, json: boolean, cwd: string): number {
  const usage = 'flow dry-run <slug> --data <file> --as <principal>'
  const slug = required(name, usage)
  const dataFile = flag(args, '--data', usage)
  const actor = flag(args, '--as', usage)
  const flow = readFlow(slug, cwd)
  if (flow.draft === undefined) {
    throw new Error('flow dry-run: the draft is empty; push a definition first')
  }
  const data = parseData(readFileSync(join(cwd, dataFile), 'utf8'))
  const run = runFlow(flow.draft, data, DRY_SOURCES, actor)
  const lines = [`active: ${run.route.active.join(', ') || 'none'}`]
  if (run.route.skipped.length > 0) {
    lines.push(`skipped: ${run.route.skipped.map((skip) => skip.step).join(', ')}`)
  }
  lines.push(`intents: ${run.intents.length}`)
  report(json, { ok: true, slug, actor, route: run.route, intents: run.intents }, lines.join('\n'))
  return 0
}

/** Compare two sides of a flow and return the named differences (DF-6). */
function diffChanges(flow: Flow, from: string, to: string): readonly DefinitionChange[] {
  const previous = resolveSide(flow, from)
  const next = resolveSide(flow, to)
  if (previous.kind === 'version' && next.kind === 'version') {
    return versionDiff(previous.version, next.version)
  }
  return classifyChange(definitionOf(previous), definitionOf(next))
}

/** One side of a diff: a published version, or the draft (DF-6, DR-1). */
type DiffSide =
  | { readonly kind: 'version'; readonly version: FlowVersion }
  | { readonly kind: 'draft'; readonly definition: FlowDefinition }

/** Resolve a diff side from a version number or `draft` (DF-6). */
function resolveSide(flow: Flow, ref: string): DiffSide {
  if (ref === 'draft') {
    if (flow.draft === undefined) {
      throw new Error('flow diff: the draft is empty; push a definition first')
    }
    return { kind: 'draft', definition: flow.draft }
  }
  const version = flow.versions.find((entry) => entry.version === Number(ref))
  if (version === undefined) throw new Error(`flow diff: there is no version ${ref}`)
  return { kind: 'version', version }
}

/** The definition of a diff side, whichever kind it is. */
function definitionOf(side: DiffSide): FlowDefinition {
  return side.kind === 'version' ? side.version.definition : side.definition
}

/** Parse a data file for a dry run as the record that a condition reads (S05). */
function parseData(text: string): ConditionData {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('flow dry-run: the data file is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('flow dry-run: the data file must be a JSON object')
  }
  // SAFETY: the check above admits only a JSON object, which is the shape of
  // ConditionData; the values are JSON values for the condition evaluator.
  return value as ConditionData
}

/**
 * The slug of a definition file: its base name without the canonical suffix
 * (DF-4). The file name is the flow's identity on the command line, so a file
 * that does not end with `.flow.json` is an error.
 */
function slugOf(file: string): string {
  const base = basename(file)
  if (!base.endsWith(FILE_SUFFIX)) {
    throw new Error(`flow file: ${base} must end with ${FILE_SUFFIX}`)
  }
  return base.slice(0, -FILE_SUFFIX.length)
}

/** Report one directory synchronization pass (ID-5). */
function report_(
  json: boolean,
  result: {
    readonly visited: number
    readonly deprovisioned: readonly string[]
    readonly provisioned: readonly string[]
  }
): void {
  report(
    json,
    { ok: true, ...result },
    `visited ${result.visited} account(s); deprovisioned ${result.deprovisioned.length}, provisioned ${result.provisioned.length}`
  )
}

/** The help text: every service command and the `flow` group (DE-2). */
function printHelp(): void {
  process.stdout.write(
    [
      versionLine(),
      '',
      'Commands:',
      '  init      write the configuration, create the database, migrate, create the first administrator and serve',
      '  serve     serve the configured public URL',
      '  migrate   apply the schema migrations; --status reports them',
      '  worker    deliver the outbox through SMTP',
      '  admin     create the first administrator (admin create), rebuild the projections (admin rebuild),',
      '            synchronize the accounts with the directory once (admin sync), or deprovision a user',
      '            through the server (admin deprovision <user-id>; sign in first)',
      '            back up the store to a file (admin backup --out <file>) or restore one into an empty store (admin restore <file>)',
      '  seed      load a demo seed (seed demo) or remove only its records (seed clear)',
      '  doctor    check the configuration, the database, the identity provider and email, and report the version',
      '  version   print the version',
      '  help      print this help',
      '',
      'Flow commands:',
      '  flow init|validate|pull|push|publish|diff|dry-run',
      '',
      'Story commands (through the server; sign in first):',
      '  login [--server <url>] [--username <name> --password <secret>], logout',
      '  grant add|list|revoke',
      '  instance start|edit|submit|show|timeline|withdraw|cancel|undo',
      '  task list|show|claim|complete|takeover|release|reassign',
      '  undo <event-seq> --instance <id> --reason <text>',
      '  log [--instance <id>] [--limit <n>]',
      '',
      'Every command accepts --json. The server is --server, ENFORM_SERVER or the last sign-in.',
      '',
    ].join('\n')
  )
}

/** Dispatch one service command of ADR 0011. */
function runServiceCommand(
  group: string,
  action: string | undefined,
  args: Args,
  json: boolean
): number | Promise<number> {
  if (group === 'init') return commandInit(args, json)
  if (group === 'serve') return commandServe(args)
  if (group === 'migrate') return commandMigrate(args, json)
  if (group === 'worker') return commandWorker(args)
  if (group === 'admin') return commandAdmin(action, args, json)
  if (group === 'seed') return commandSeed(action, args, json)
  if (group === 'doctor') return commandDoctor(args, json)
  throw new Error(`unknown command: ${group}`)
}

/** `enform init`: the walking skeleton of DE-1. */
async function commandInit(args: Args, json: boolean): Promise<number> {
  const usage =
    'enform init --admin-email <email> --admin-password <password> [--smtp-url <url>] [--mail-from <address>] [--config <path>]'
  const path = configPath(args.flags)
  const loaded = loadConfig(args.flags)
  // The refresh-token cipher needs one key per installation (#218). `init`
  // writes one when the configuration has none, so a fresh install is never
  // left without the ability to store a refresh token.
  const config =
    loaded.session.encryptionKey === ''
      ? {
          ...loaded,
          session: { ...loaded.session, encryptionKey: newEncryptionKey() },
        }
      : loaded
  const email = flag(args, '--admin-email', usage)
  const password = flag(args, '--admin-password', usage)
  writeConfig(config, path)
  const admin = await bootstrap(config, { email, password })
  report(
    json,
    { ok: true, config: path, admin },
    `wrote ${path}; the first administrator is ${email}`
  )
  if (has(args, '--no-serve')) return 0
  return serveUntilStopped(config)
}

/** `enform serve`: refuse pending migrations unless `--auto-migrate` (ADR 0011). */
async function commandServe(args: Args): Promise<number> {
  const config = loadConfig(args.flags)
  const pool = createPool(config.databaseUrl)
  try {
    const status = await migrationStatus(pool)
    if (status.pending.length > 0 && !has(args, '--auto-migrate')) {
      throw new Error(
        `pending migrations: ${status.pending.join(', ')}; run enform migrate or pass --auto-migrate`
      )
    }
    if (status.pending.length > 0) await runMigrations(pool)
  } finally {
    await pool.end()
  }
  return serveUntilStopped(config)
}

/** `enform migrate [--status]`: apply or report the migrations (DE-5, ADR 0011). */
async function commandMigrate(args: Args, json: boolean): Promise<number> {
  const config = loadConfig(args.flags)
  const pool = createPool(config.databaseUrl)
  try {
    if (has(args, '--status')) {
      const status = await migrationStatus(pool)
      const text =
        status.pending.length === 0
          ? `applied ${status.applied.length} migration(s); none pending`
          : `applied ${status.applied.length} migration(s); pending ${status.pending.join(', ')}`
      report(json, { ok: true, ...status }, text)
      return 0
    }
    const applied = await runMigrations(pool)
    const status = await migrationStatus(pool)
    report(
      json,
      { ok: true, applied, migrated: status.applied },
      `applied ${applied.length} migration(s); ${status.applied.length} in total, none pending`
    )
    return 0
  } finally {
    await pool.end()
  }
}

/** `enform worker`: poll the outbox and timers until SIGTERM (ADR 0011, ADR 0013). */
async function commandWorker(args: Args): Promise<number> {
  const config = loadConfig(args.flags)
  const worker = startWorker(config)
  process.stderr.write('enform worker: delivering the outbox\n')
  await waitForSignal(async () => worker.stop())
  return 0
}

/**
 * `enform admin create|rebuild|sync|deprovision`: the first administrator, the
 * rebuild (ADR 0013), one directory synchronization pass (ID-5, #267), and
 * the deprovision of one user through the server (ID-5, #267).
 */
async function commandAdmin(
  action: string | undefined,
  args: Args,
  json: boolean
): Promise<number> {
  if (action === 'deprovision') {
    return runAdminDeprovision(args.positionals[2], args, json, process.env)
  }
  if (action === 'sync') {
    const config = loadConfig(args.flags)
    const pool = createPool(config.databaseUrl)
    try {
      const report = await syncDirectory(pool, config, Date.now())
      report_(json, report)
      return 0
    } finally {
      await pool.end()
    }
  }
  if (action === 'create') {
    const usage = 'enform admin create --admin-email <email> --admin-password <password>'
    const email = flagAny(args, ['--admin-email', '--email'], usage)
    const password = flagAny(args, ['--admin-password', '--password'], usage)
    const config = loadConfig(args.flags)
    const admin = await bootstrap(config, { email, password })
    report(json, { ok: true, admin }, `created ${email}`)
    return 0
  }
  if (action === 'rebuild') {
    const config = loadConfig(args.flags)
    const pool = createPool(config.databaseUrl)
    try {
      const events = await rebuild(pool)
      report(json, { ok: true, events }, `rebuilt ${events} event(s)`)
      return 0
    } finally {
      await pool.end()
    }
  }
  if (action === 'backup') return commandBackup(args, json)
  if (action === 'restore') return commandRestore(args, json)
  throw new Error(`unknown admin command: ${action ?? ''}`.trim())
}

/**
 * `enform admin backup --out <file>`: write the log and the operational state
 * beside it to one JSON file (DE-5, D3). The file is the portable backup of
 * an installation; `pg_dump` of the database is the other, and both are
 * documented in docs/operations.md.
 */
async function commandBackup(args: Args, json: boolean): Promise<number> {
  const file = flag(args, '--out', 'enform admin backup --out <file>')
  const config = loadConfig(args.flags)
  const pool = createPool(config.databaseUrl)
  try {
    const backup = await exportStore(pool, VERSION, Date.now())
    writeFileSync(file, `${JSON.stringify(backup)}\n`, { mode: 0o600 })
    report(
      json,
      { ok: true, file, events: backup.events.length, takenAt: backup.takenAt },
      `wrote ${file}: ${backup.events.length} event(s)`
    )
    return 0
  } finally {
    await pool.end()
  }
}

/**
 * `enform admin restore <file>`: create the database when it is missing,
 * migrate it, load the backup into its empty log and rebuild the projections
 * (DE-5). A store that already holds a log is refused (I4).
 */
async function commandRestore(args: Args, json: boolean): Promise<number> {
  const file = required(args.positionals[2], 'enform admin restore <file> [--database-url <url>]')
  const config = loadConfig(args.flags)
  let backup: StoreBackup
  try {
    backup = JSON.parse(readFileSync(file, 'utf8')) as StoreBackup
  } catch (error) {
    throw new Error(`cannot read the backup ${file}: ${messageOf(error)}`)
  }
  if (backup.format !== 1 || !Array.isArray(backup.events)) {
    throw new Error(`${file} is not an enform backup`)
  }
  await createDatabaseIfMissing(config.databaseUrl)
  const pool = createPool(config.databaseUrl)
  try {
    await runMigrations(pool)
    const events = await importStore(pool, backup)
    report(
      json,
      { ok: true, file, events, version: backup.version, takenAt: backup.takenAt },
      `restored ${events} event(s) from ${file} (taken by enform ${backup.version})`
    )
    return 0
  } finally {
    await pool.end()
  }
}

/** `enform seed demo|clear`: load or clear the demo organization (DE-4). */
async function commandSeed(action: string | undefined, args: Args, json: boolean): Promise<number> {
  if (action !== 'demo' && action !== 'clear') {
    throw new Error(`unknown seed command: ${action ?? ''}`.trim())
  }
  const config = loadConfig(args.flags)
  const pool = createPool(config.databaseUrl)
  try {
    const status = await migrationStatus(pool)
    if (status.pending.length > 0) {
      throw new Error(`pending migrations: ${status.pending.join(', ')}; run enform migrate`)
    }
    if (action === 'demo') {
      const result = await seedDemo(config, pool)
      report(json, { ok: true, ...result }, demoText(result))
      return 0
    }
    if (!has(args, '--yes') && !(await confirmSeedClear())) {
      report(json, { ok: true, cleared: false, profile: 'demo' }, 'demo seed not cleared')
      return 0
    }
    const result = await clearDemo(config, pool)
    report(json, { ok: true, ...result }, clearText(result))
    return 0
  } finally {
    await pool.end()
  }
}

/** Ask before a clear that did not pass `--yes`. A non-interactive run is refused. */
async function confirmSeedClear(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('refusing to clear the demo seed without --yes')
  }
  const readline = await import('node:readline/promises')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question('Remove the demo seed records? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

/** The text of `seed demo`: the credentials once and the flow URL (DE-4). */
function demoText(result: Awaited<ReturnType<typeof seedDemo>>): string {
  if (result.alreadySeeded) {
    return `demo seed: profile demo is already loaded (${result.records} record(s)); run enform seed clear first`
  }
  const lines = [
    `demo seed: profile demo run ${result.run ?? ''}`,
    `flow: ${result.flow?.title ?? ''} ${result.flow?.url ?? ''}`,
    'users (the password is shown once):',
  ]
  for (const user of result.users ?? []) {
    lines.push(`  ${user.email} ${user.password} ${user.id} (${user.displayName}, ${user.role})`)
  }
  lines.push('instances:')
  for (const instance of result.instances ?? []) {
    lines.push(`  ${instance.id} ${instance.done ? 'done' : instance.step}`)
  }
  return lines.join('\n')
}

/** The text of `seed clear`: exactly the records that the clear removed (DE-4). */
function clearText(result: Awaited<ReturnType<typeof clearDemo>>): string {
  const { cleared, operationId } = result
  if (operationId === '') return 'demo seed: no live records to clear'
  const lines = [
    `cleared demo seed: ${cleared.users.length} user(s), ${cleared.groups.length} group(s), ${cleared.teams.length} team(s), ${cleared.flows.length} flow(s), ${cleared.instances.length} instance(s), ${cleared.grants.length} grant(s)`,
    `seed.cleared@1 ${operationId}`,
  ]
  for (const kind of ['users', 'groups', 'teams', 'flows', 'instances', 'grants'] as const) {
    for (const record of cleared[kind]) lines.push(`  ${record.kind} ${record.id}`)
  }
  return lines.join('\n')
}

/** `enform doctor`: check the configuration, the database, the identity provider and email (DE-5). */
async function commandDoctor(args: Args, json: boolean): Promise<number> {
  const config = loadConfig(args.flags)
  const keyOk = validEncryptionKey(config.session.encryptionKey)
  const checks: { readonly name: string; readonly ok: boolean; readonly detail: string }[] = [
    { name: 'version', ok: true, detail: versionLine() },
    { name: 'config', ok: true, detail: `${configPath(args.flags)} -> ${config.publicUrl}` },
    {
      name: 'session encryption key',
      ok: keyOk,
      detail: keyOk
        ? '32-byte key in base64'
        : 'missing or not a 32-byte key in base64; run enform init or set session.encryptionKey',
    },
  ]

  const pool = createPool(config.databaseUrl)
  try {
    await pool.query('select 1')
    const status = await migrationStatus(pool)
    checks.push({
      name: 'database',
      ok: status.pending.length === 0,
      detail:
        status.pending.length === 0
          ? `${status.applied.length} migration(s) applied`
          : `pending migrations: ${status.pending.join(', ')}`,
    })
  } catch (error) {
    checks.push({ name: 'database', ok: false, detail: messageOf(error) })
  } finally {
    await pool.end()
  }

  try {
    await oidcConfiguration(config)
    checks.push({ name: 'identity provider', ok: true, detail: issuerUrl(config) })
  } catch (error) {
    checks.push({ name: 'identity provider', ok: false, detail: messageOf(error) })
  }

  const mail = await checkMail(config)
  checks.push({ name: 'email', ok: mail.ok, detail: mail.detail })

  const ok = checks.every((check) => check.ok)
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, version: VERSION, checks })}\n`)
  } else {
    for (const check of checks) {
      process.stdout.write(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}\n`)
    }
  }
  return ok ? 0 : 1
}

/** Serve until SIGTERM or SIGINT drains the server (DE-3). */
async function serveUntilStopped(config: ReturnType<typeof loadConfig>): Promise<number> {
  const service = await serveHttp(config)
  process.stderr.write(`enform: serving ${config.publicUrl} on ${config.httpAddr}\n`)
  await waitForSignal(() => service.close())
  return 0
}

/** Await SIGTERM or SIGINT, run the drain, and resolve once it finished. */
function waitForSignal(drain: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop = (): void => {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
      drain().then(resolve, reject)
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  })
}

/** The first of several flag spellings, or an error that names the usage. */
function flagAny(args: Args, keys: readonly string[], usage: string): string {
  for (const key of keys) {
    const values = args.flags.get(key)
    if (values !== undefined && values.length > 0) return values[0]
  }
  throw new Error(`missing ${keys[0]}: usage is ${usage}`)
}

/** The message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
