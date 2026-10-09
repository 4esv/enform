import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

// Issue #29, STORIES.md Coverage and Traceability: the build writes
// stories/MATRIX.md from STORIES.md and MVP.md, and CI fails on an uncovered
// in-scope requirement, a story that is claimed to pass without an operator, a
// skipped cell without a reason, or an unknown ID. The checks run the real
// scripts the way the local check and CI do.

const repo = join(import.meta.dirname, '..')
const generator = join(repo, 'tools', 'matrix.mjs')
const rule = join(repo, 'tools', 'matrix-rule.mjs')

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

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'enform-matrix-'))
  temps.push(dir)
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

test('#29 the generator writes stories/MATRIX.md from the real documents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enform-docs-'))
  temps.push(dir)
  cpSync(join(repo, 'MVP.md'), join(dir, 'MVP.md'))
  cpSync(join(repo, 'STORIES.md'), join(dir, 'STORIES.md'))
  cpSync(join(repo, 'stories'), join(dir, 'stories'), { recursive: true })
  rmSync(join(dir, 'stories', 'MATRIX.md'), { force: true })

  const generated = run([generator, dir])
  expect(generated.status, generated.stderr).toBe(0)

  const matrix = readFileSync(join(dir, 'stories', 'MATRIX.md'), 'utf8')
  for (const id of ['S01', 'S07', 'S16']) expect(matrix).toContain(`## ${id}:`)
  for (const operator of [
    'Actor',
    'Duplicate',
    'Race',
    'Fault',
    'Offline',
    'Clock',
    'Data',
    'Version',
  ]) {
    expect(matrix, `${operator} is a row`).toContain(`| ${operator} |`)
  }
  expect(matrix, 'the four modes are columns').toContain('| Operator | api | cli | dry | gui |')
  expect(matrix, 'S01 runs Duplicate in api mode').toContain('| Duplicate | run | - | - | - |')
  expect(matrix, 'S07 writes why cli skips').toContain(
    '- S07 `cli`: The engine path is a transport simulation, and the CLI has no transport to interrupt.'
  )
  expect(matrix, 'DX-1 has no story').toContain('| DX-1 | - |')
})

test('#29 the committed stories/MATRIX.md is current', () => {
  const target = join(repo, 'stories', 'MATRIX.md')
  const before = readFileSync(target, 'utf8')
  const generated = run([generator])
  expect(generated.status, generated.stderr).toBe(0)
  expect(readFileSync(target, 'utf8'), 'run node tools/matrix.mjs and commit the result').toBe(
    before
  )
})

test('#29 the rule passes on the real documents', () => {
  const result = run([rule])
  expect(result.status, result.stderr).toBe(0)
})

// The rule fails for each condition of STORIES.md, Coverage and Traceability.

const MVP = `# enform: MVP Specification

## 2. Axioms

| ID | Axiom | Meaning |
|---|---|---|
| A1 | Nobody blocks anybody. | None. |

## 4. Invariants

| ID | Invariant | Axioms | Suite |
|---|---|---|---|
| I1 | Idempotent operations. | A1 | \`invariants/I1-idempotent-ops\` |

## 5. In scope

### 5.1 Identity (ID)

| ID | Requirement | Traces to |
|---|---|---|
| ID-1 | Sign-in uses OIDC. | A1 |

## 8. Release plan

| Version | Milestone | Contents | Demonstration |
|---|---|---|---|
| \`0.1.0\` | Foundation | Identity (ID-1). | A user signs in. |

## 12. Decisions

| ID | Decision | Reason |
|---|---|---|
| D1 | One author fills in a form. | A1. |
`

function stories(refs: string, options: { status?: string; modes?: string } = {}): string {
  const modes = options.modes ? `\n**Modes.** ${options.modes}\n` : ''
  return `# enform: Stories

## Rules

## Test method

## Evidence

| Story | Engine issue | Engine tests | Engine commits | Interface issue | Interface commits | Status |
|---|---|---|---|---|---|---|
| S01 | | | | | | ${options.status ?? 'Not started'} |

## Part 1: Build

### S01: Create and publish a flow (\`publish-flow\`)

**Refs.** ${refs}
${modes}`
}

function fixtureRepo(storyText: string): string {
  const dir = makeRepo({ 'MVP.md': MVP, 'STORIES.md': storyText })
  const generated = run([generator, dir])
  expect(generated.status, generated.stderr).toBe(0)
  return dir
}

test('#29 the rule fails on an in-scope requirement with no story and no test', () => {
  const dir = fixtureRepo(stories('I1'))
  const result = run([rule, dir])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('in-scope requirement ID-1 has no story and no requirement test')
})

test('#29 the rule fails on a story that is claimed to pass without an operator', () => {
  const dir = fixtureRepo(stories('ID-1', { status: 'Done' }))
  const result = run([rule, dir])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('S01 is Done but does not run the Actor operator')
})

test('#29 the rule fails on a skipped cell without a written reason', () => {
  const dir = fixtureRepo(stories('ID-1', { modes: 'The `cli` cell is skipped.' }))
  const result = run([rule, dir])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('S01: the cli cell is skipped without a written reason')
})

test('#29 the rule fails on a story that cites an unknown ID', () => {
  const dir = fixtureRepo(stories('ID-1, ZZ-9'))
  const result = run([rule, dir])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('S01 cites an unknown ID: ZZ-9')
})

test('#29 the rule fails when stories/MATRIX.md is stale', () => {
  const dir = fixtureRepo(stories('ID-1'))
  writeFileSync(join(dir, 'stories', 'MATRIX.md'), '# stale\n')
  const result = run([rule, dir])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('stories/MATRIX.md is not current')
})
