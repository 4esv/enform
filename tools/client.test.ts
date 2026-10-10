import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

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

test.fails('#93 DX-4 the generator reproduces the checked-in client byte for byte', () => {
  const out = join(temp, 'client.ts')
  const result = run([generator, out])
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(clientPath), 'the generated client is checked in').toBe(true)
  expect(readFileSync(out, 'utf8'), 'the checked-in client is current').toBe(
    readFileSync(clientPath, 'utf8')
  )
})

test.fails('#93 DX-4 the generated client exposes the three typed operations (I12)', () => {
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
})

test.fails('#93 DX-4 a hand-written /api/v1 call in the interface fails the rule (I12)', () => {
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
