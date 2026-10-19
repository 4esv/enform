import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  appendOperation,
  type FieldError,
  type Operation,
  RequestRefused,
  setClient,
} from '../interface/client/client.js'

// Issue #93, DX-4, I12, MVP.md 9.1: the interface uses only the generated API
// client, and the client is generated from api/openapi.yaml. The generator is
// deterministic, so a fresh regeneration must equal the checked-in client
// byte for byte. The rule marks a hand-written /api/v1 call in the interface.

const repo = join(import.meta.dirname, '..')
const generator = join(repo, 'tools', 'generate-client.mjs')
const clientPath = join(repo, 'interface', 'client', 'client.ts')
const rule = join(repo, 'tools', 'public-api-rule.mjs')

const temp = mkdtempSync(join(tmpdir(), 'enform-93-'))

afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
})

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', args, { cwd: repo, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

test('#93 DX-4 the generator reproduces the checked-in client byte for byte', () => {
  const out = join(temp, 'client.ts')
  const result = run([generator, out])
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(clientPath), 'the generated client is checked in').toBe(true)
  expect(readFileSync(out, 'utf8'), 'the checked-in client is current').toBe(
    readFileSync(clientPath, 'utf8')
  )
})

test('#93 DX-4 the generated client exposes the four typed operations (I12)', () => {
  expect(existsSync(clientPath), 'the generated client is checked in').toBe(true)
  const source = readFileSync(clientPath, 'utf8')
  expect(source, 'appendOperation takes an Operation and returns an Event').toContain(
    'export async function appendOperation(operation: Operation): Promise<Event> {'
  )
  expect(source, 'readLog returns a Log').toContain(
    'export async function readLog(): Promise<Log> {'
  )
  expect(source, 'readState returns a State').toContain(
    'export async function readState(): Promise<State> {'
  )
  expect(source, 'readFlow takes a slug and returns a PublishedFlow').toContain(
    'export async function readFlow(slug: string): Promise<PublishedFlow> {'
  )
})

// Issue #106, FM-4, DX-4, I12, ADR 0010: a validation refusal is HTTP 409
// with a `CompletionRefusal` body (api/openapi.yaml). The generated client
// must surface that body, so the form can name every field error by path
// (FM-1, FM-4) instead of losing it behind a status line.
type Refusal = Error & {
  readonly status: number
  readonly error: string
  readonly errors: readonly FieldError[]
}

const operation: Operation = {
  id: '0190f2c8-9a1e-7c3b-8f2a-6d4e1b0c9a87',
  type: 'step.completed@1',
  at: 1,
  actor: 'user-1',
  payload: {},
}

beforeEach(() => {
  setClient({ baseUrl: 'http://api.test', token: 'token' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function respond(status: number, body: string, statusText = ''): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status, statusText })))
}

// The error that appendOperation rejects with. A resolved promise is a failure
// of the check, because every status below is non-2xx.
async function refusal(): Promise<Refusal> {
  try {
    await appendOperation(operation)
  } catch (error) {
    return error as Refusal
  }
  throw new Error('the client resolved a non-2xx response')
}

test('#106 a 409 refusal surfaces its reason and every field error (FM-4, DX-4, I12)', async () => {
  const body = {
    error: 'step request: summary is required (FM-4)',
    errors: [{ path: 'summary', message: 'is required' }],
  }
  respond(409, JSON.stringify(body))
  const error = await refusal()
  expect(error).toBeInstanceOf(RequestRefused)
  expect(error.status, 'the status is the refusal status').toBe(409)
  expect(error.error, 'the reason the engine gave').toBe(body.error)
  expect(error.errors, 'every field error by path').toEqual(body.errors)
  expect(error.message, 'the message names the status and the reason').toContain('409')
  expect(error.message).toContain(body.error)
})

test('#106 a 400 refusal without field errors reports an empty list (FM-4, DX-4)', async () => {
  respond(400, JSON.stringify({ error: 'intent: the instance id is missing' }))
  const error = await refusal()
  expect(error).toBeInstanceOf(RequestRefused)
  expect(error.status).toBe(400)
  expect(error.error).toBe('intent: the instance id is missing')
  expect(error.errors, 'no field errors means an empty list').toEqual([])
})

test('#106 a 500 with a non-JSON body keeps the plain Error that names the status', async () => {
  respond(500, 'not json', 'Internal Server Error')
  const error = await refusal()
  expect(error.name, 'a body that is not a refusal stays a plain Error').toBe('Error')
  expect(error.message).toContain('500')
  expect(error.message).toContain('Internal Server Error')
})

test('#93 DX-4 a hand-written /api/v1 call in the interface fails the rule (I12)', () => {
  const dir = mkdtempSync(join(temp, 'rule-'))
  mkdirSync(join(dir, 'interface', 'client'), { recursive: true })
  writeFileSync(
    join(dir, 'interface', 'app.ts'),
    ['export async function load() {', "  return fetch('/api/v1/state')", '}', ''].join('\n')
  )
  writeFileSync(join(dir, 'interface', 'client', 'client.ts'), '// the generated client (DX-4)\n')
  const result = run([rule, dir])
  expect(result.status, result.stderr).toBe(1)
  expect(result.stderr, 'the rule names the interface file').toContain('interface/app.ts')
})
