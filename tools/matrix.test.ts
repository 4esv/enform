import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

// Issue #29, STORIES.md Coverage and Traceability: the build writes
// stories/MATRIX.md from STORIES.md and MVP.md. This first check is marked
// expected to fail until the generator renders the real matrix.

const repo = join(import.meta.dirname, '..')
const generator = join(repo, 'tools', 'matrix.mjs')
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test.fails('#29 the generator writes stories/MATRIX.md from the real documents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enform-docs-'))
  temps.push(dir)
  cpSync(join(repo, 'MVP.md'), join(dir, 'MVP.md'))
  cpSync(join(repo, 'STORIES.md'), join(dir, 'STORIES.md'))
  cpSync(join(repo, 'stories'), join(dir, 'stories'), { recursive: true })
  rmSync(join(dir, 'stories', 'MATRIX.md'), { force: true })

  execFileSync('node', [generator, dir], { cwd: repo, encoding: 'utf8' })
  const matrix = readFileSync(join(dir, 'stories', 'MATRIX.md'), 'utf8')
  expect(matrix).toContain('## S01:')
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
})
