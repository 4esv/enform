// Issue #18, I12, A3, A9: the public API only oracle.
//
// I12: the interface uses only the generated public API client. A lint rule
// enforces this. Until the client is generated (DX-4), the interface may
// import the client and the engine's public entry, `engine/index.ts`, which
// re-exports the engine's public modules. Every other module under `engine/`
// is internal (MVP.md 9.1), so an interface file that imports one is a
// violation. The suite below runs `tools/public-api-rule.mjs` the way the
// local check and CI do: a clean interface fixture passes the rule, and a
// deliberate violation makes the rule fail.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const repo = join(import.meta.dirname, '..', '..')
const rule = join(repo, 'tools', 'public-api-rule.mjs')

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
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

// A fixture repository with the files of a case, so a case states only the
// interface code that it exercises.
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'enform-public-api-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

test('#18 an interface that imports the public API passes the rule (I12)', () => {
  const dir = makeRepo({
    'interface/app.ts': [
      "import { appendOperation } from './client/client.js'",
      "import { rebuild } from '../engine/index.js'",
      '',
    ].join('\n'),
  })
  const result = run([rule, dir])
  expect(result.status, result.stderr).toBe(0)
})

test('#18 the rule passes while the interface directory does not exist (I12)', () => {
  const result = run([rule])
  expect(result.status, result.stderr).toBe(0)
})

test('#18 the rule fails when the interface imports an engine internal (I12)', () => {
  const dir = makeRepo({
    'interface/app.ts': "import { createInstance } from '../engine/instance.js'\n",
  })
  const result = run([rule, dir])
  expect(result.status, 'the rule rejects the engine internal').toBe(1)
  expect(result.stderr, 'the rule names the internal').toContain('engine/instance.js')
})

// Issue #93, DX-4: the interface reaches the API through the generated client
// only. A `/api/v1` path in any other interface file is a hand-written call.
test('#93 the rule fails when the interface calls /api/v1 by hand (I12, DX-4)', () => {
  const dir = makeRepo({
    'interface/app.ts': [
      'export async function load() {',
      "  return fetch('/api/v1/state')",
      '}',
      '',
    ].join('\n'),
    'interface/client/client.ts': '// the generated client (DX-4)\n',
  })
  const result = run([rule, dir])
  expect(result.status, 'the rule rejects the hand-written call').toBe(1)
  expect(result.stderr, 'the rule names the interface file').toContain('interface/app.ts')
})

test('#93 the rule allows the generated client to name the /api/v1 paths (I12, DX-4)', () => {
  const dir = makeRepo({
    'interface/client/client.ts': "export const path = '/api/v1/state'\n",
  })
  const result = run([rule, dir])
  expect(result.status, result.stderr).toBe(0)
})
