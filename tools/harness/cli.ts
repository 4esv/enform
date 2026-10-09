import { readFileSync } from 'node:fs'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Operation } from '../../engine/operation.js'
import { fromView, type StateView, toView } from './scenario.js'

// Issue #25, STORIES.md Golden path: the harness CLI. One operation goes in
// through the engine, and the resulting state comes out, so cli mode runs the
// same steps as api mode and the two modes must be equal. It is harness
// infrastructure, not the release `enform` CLI (a later milestone): one
// operation in, one state out, no network. The caller supplies the clock and
// the IDs in the operation itself, so the result is deterministic (I6).
//
// Usage: node --import tools/harness/ts-resolve.ts tools/harness/cli.ts \
//   [--json <operation>] [--state <state>]
//
// The operation is a JSON string, via --json or on stdin. --state is the prior
// state, in the shape that /api/v1/state returns, and defaults to the empty
// state. The exit code is 0 on success and 1 on bad input.

const USAGE = 'usage: cli.ts [--json <operation>] [--state <state>]'

function fail(message: string): never {
  throw new Error(message)
}

/** The value of `--name`, or undefined when the flag is absent. */
function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/** Parse one operation, and reject anything that is not an operation. */
function parseOperation(text: string): Operation {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail('the operation is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) fail('the operation is not an object')
  // SAFETY: the guard above proves value is an object; the fields are read as
  // unknown and each one is checked below.
  const operation = value as Record<string, unknown>
  if (
    typeof operation.id !== 'string' ||
    typeof operation.type !== 'string' ||
    typeof operation.at !== 'number' ||
    (operation.actor !== undefined && typeof operation.actor !== 'string') ||
    typeof operation.payload !== 'object' ||
    operation.payload === null
  ) {
    fail('the operation is invalid: id, type, at and payload are required')
  }
  // SAFETY: the checks above prove that id, type, at, actor and payload have
  // the shapes of an Operation.
  return operation as Operation
}

/** Parse the prior state in the shape that /api/v1/state returns. */
function parseState(text: string): State {
  let view: unknown
  try {
    view = JSON.parse(text)
  } catch {
    fail('the prior state is not valid JSON')
  }
  if (typeof view !== 'object' || view === null) fail('the prior state is not an object')
  // SAFETY: the runner writes --state with toView, so it is a StateView.
  return fromView(view as StateView)
}

/** Apply one operation, from `--json` or stdin, to the prior state, if any. */
function run(argv: readonly string[]): State {
  const json = argument(argv, '--json')
  const operation = parseOperation(json ?? readFileSync(0, 'utf8'))
  const state = argument(argv, '--state')
  return apply(operation, state === undefined ? emptyState : parseState(state))
}

try {
  process.stdout.write(`${JSON.stringify(toView(run(process.argv.slice(2))))}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`cli: ${message}\n${USAGE}\n`)
  process.exitCode = 1
}
