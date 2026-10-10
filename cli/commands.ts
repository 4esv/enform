// Issue #38, S01, DF-1, DF-4, DX-3, I9: the `enform` command. The command
// groups are `login`, `flow`, `grant`, `instance`, `task`, `undo` and `log`
// (cli/README.md); this commit covers the stateless `flow` file commands:
// `init`, `validate` and `pull`, and scaffolds the stateful `push`, `publish`,
// `diff` and `dry-run` commands as stubs. The next commit fills them in and
// unmarks their checks. The CLI is file-backed and in-process: it imports the
// engine and never uses a server or the network. The CLI holds no correctness
// logic (A9); it parses the arguments, calls the engine and reports. Every
// command accepts `--json`. The command names, flags, exit codes and `--json`
// output are a public surface (MVP.md 9.1), so the shapes below change only
// with that surface. The CLI is deterministic (I6).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FlowDefinition, parse, SCHEMA_VERSION, serialize } from '../engine/definition.js'
import { validate } from '../engine/flow.js'

/** The canonical extension of a flow definition file (DF-4). */
const FILE_SUFFIX = '.flow.json'

/**
 * The minimal definition that `flow init` writes for a new draft (DF-1). One
 * step assigns to the starter, so the file is a valid flow the author edits
 * into shape.
 */
const STARTER_DEFINITION: FlowDefinition = {
  schemaVersion: SCHEMA_VERSION,
  steps: [{ key: 'start', targets: [{ starter: 'starter' }] }],
}

/**
 * Run one `enform` command line and return its exit code. The result goes to
 * stdout, an error to stderr; success is 0 and every error is 1 (MVP.md 9.1).
 * With `--json` both cases write one JSON object to stdout, so a caller reads
 * the outcome the same way on success and on failure.
 */
export function main(argv: readonly string[]): number {
  const json = argv.includes('--json')
  const args = argv.filter((arg) => arg !== '--json')
  try {
    return run(args, json, process.cwd())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    else process.stderr.write(`enform: ${message}\n`)
    return 1
  }
}

/** Dispatch the positionals to one flow command, or refuse an unknown command. */
function run(args: readonly string[], json: boolean, cwd: string): number {
  const [group, action, name] = args
  if (group !== 'flow') throw new Error(`unknown command group: ${group ?? ''}`.trim())
  if (action === 'init') return flowInit(name, json, cwd)
  if (action === 'validate') return flowValidate(name, json, cwd)
  if (action === 'pull') return flowPull(name, json, cwd)
  if (action === 'push') return notImplemented('flow push')
  if (action === 'publish') return notImplemented('flow publish')
  if (action === 'diff') return notImplemented('flow diff')
  if (action === 'dry-run') return notImplemented('flow dry-run')
  throw new Error(`unknown flow command: ${action ?? ''}`.trim())
}

/**
 * Refuse a command that the next commit implements. The check that covers it is
 * marked expected to fail until then, so the suite stays green (issue #38).
 */
function notImplemented(command: string): number {
  throw new Error(`${command}: not implemented yet`)
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
 * byte for byte when the file is already canonical (I9). Persistence moves to
 * `.enform/` in a later unit and this command reads the stored draft instead.
 */
function flowPull(name: string | undefined, json: boolean, cwd: string): number {
  const slug = required(name, 'flow pull <slug>')
  const file = `${slug}${FILE_SUFFIX}`
  const path = join(cwd, file)
  writeFileSync(path, serialize(parse(readFileSync(path, 'utf8'))))
  report(json, { ok: true, slug, path: file }, `wrote ${file}`)
  return 0
}

/** The value of a required positional, or an error that names the usage. */
function required(value: string | undefined, usage: string): string {
  if (value === undefined) throw new Error(`missing argument: usage is ${usage}`)
  return value
}

/** Write the outcome: one JSON object with `--json`, a plain line otherwise. */
function report(json: boolean, value: Record<string, unknown>, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`)
}
