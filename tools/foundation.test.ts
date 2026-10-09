import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

// The checks of issue #95: the five commands and the layout of MVP.md 9.1.
// They run against a copy of the working tree without its test files. The
// copy is the empty suite, and its `make check` never runs this file again.

const repo = join(import.meta.dirname, '..')
const timeout = 120_000
let copy = ''
let setup: Result = { status: null, output: '' }

type Result = { status: number | null; output: string }

function run(cmd: string, args: string[], cwd: string): Result {
  const inherited = ['MAKEFLAGS', 'MAKELEVEL', 'MFLAGS']
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !inherited.includes(k))
  )
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` }
}

// Every file that a commit would contain: tracked, or untracked and not ignored.
function committableFiles(): string[] {
  const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
  const out = execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  return out.split('\0').filter((f) => f !== '' && existsSync(join(repo, f)))
}

function expectedFailure(name: string, body: string): string {
  return `import { expect, test } from 'vitest'\n\ntest.fails('${name}', () => {\n  ${body}\n})\n`
}

function checkWith(file: string, content: string): Result {
  const path = join(copy, 'tools', file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  try {
    return run('make', ['check'], copy)
  } finally {
    rmSync(path)
  }
}

beforeAll(() => {
  copy = mkdtempSync(join(tmpdir(), 'enform-95-'))
  for (const f of committableFiles()) {
    if (f.endsWith('.test.ts')) continue
    mkdirSync(join(copy, dirname(f)), { recursive: true })
    cpSync(join(repo, f), join(copy, f))
  }
  setup = run('make', ['setup'], copy)
}, timeout)

afterAll(() => {
  if (copy !== '') rmSync(copy, { recursive: true, force: true })
})

test(
  '#95 setup then check is green on an empty suite',
  () => {
    expect(setup.status, setup.output).toBe(0)
    const check = run('make', ['check'], copy)
    expect(check.status, check.output).toBe(0)
  },
  timeout
)

test(
  '#95 check fails when an expected failure passes',
  () => {
    const check = checkWith('passes.test.ts', expectedFailure('#0 passes', 'expect(1).toBe(1)'))
    expect(check.status, check.output).not.toBe(0)
    expect(check.output).toContain('#0 passes')
  },
  timeout
)

// The mutation of the previous check: the same file, but the failure is real.
test(
  '#95 check passes when an expected failure fails',
  () => {
    const check = checkWith('fails.test.ts', expectedFailure('#0 fails', 'expect(1).toBe(2)'))
    expect(check.status, check.output).toBe(0)
  },
  timeout
)

test('#95 the layout has the locations of MVP.md 9.1 and 11.4', () => {
  const dirs = [
    'schemas/flow',
    'schemas/realtime',
    'schemas/events',
    'cli',
    'deploy',
    'stories',
    'invariants',
  ]
  for (const d of dirs) {
    const path = join(copy, d)
    expect(existsSync(path) && statSync(path).isDirectory(), `${d} is a directory`).toBe(true)
  }
  expect(existsSync(join(copy, 'api', 'openapi.yaml')), 'api/openapi.yaml exists').toBe(true)
})
