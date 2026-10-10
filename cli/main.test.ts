import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse, serialize } from '../engine/definition.js'

// Issue #38, S01, DF-1, DF-4, DX-3, I9: the `enform` flow file commands. The
// checks run the bin as a user would, so they cover the dispatch, the exit
// codes and the `--json` output together. `init` writes a canonical file
// (DF-1), `validate` rejects an invalid file and changes nothing (DF-1), and
// `pull` reproduces the canonical file byte for byte (DF-4, I9). The output is
// deterministic (I6).

const entry = join(import.meta.dirname, 'main.ts')

/** A fresh working directory for one command run. */
function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'enform-38-'))
}

/** Run the bin in `cwd` and capture its exit code and streams. */
function enform(
  args: readonly string[],
  cwd: string
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('#38 flow init writes a canonical flow file (S01, DF-1)', () => {
  const cwd = workdir()
  const result = enform(['flow', 'init', 'course-overload'], cwd)
  expect(result.status, result.stderr).toBe(0)
  const text = readFileSync(join(cwd, 'course-overload.flow.json'), 'utf8')
  // Canonical means parse then serialize returns the same bytes (DF-4, I9).
  expect(text).toBe(serialize(parse(text)))
})

test('#38 flow validate names the error and changes nothing (S01, DF-1)', () => {
  const cwd = workdir()
  const path = join(cwd, 'bad.flow.json')
  const bad = '{ "schemaVersion": 2, "steps": [] }'
  writeFileSync(path, bad)
  const result = enform(['flow', 'validate', 'bad.flow.json', '--json'], cwd)
  expect(result.status).not.toBe(0)
  const out = JSON.parse(result.stdout)
  expect(out.ok).toBe(false)
  expect(out.error).toMatch(/schemaVersion/)
  expect(readFileSync(path, 'utf8')).toBe(bad)
})

test('#38 flow pull reproduces the canonical file byte for byte (S01, DF-4, I9)', () => {
  const cwd = workdir()
  const path = join(cwd, 'course-overload.flow.json')
  expect(enform(['flow', 'init', 'course-overload'], cwd).status).toBe(0)

  // A canonical file is unchanged: init then pull is byte for byte the same.
  const canonical = readFileSync(path, 'utf8')
  expect(enform(['flow', 'pull', 'course-overload'], cwd).status).toBe(0)
  expect(readFileSync(path, 'utf8')).toBe(canonical)

  // Any valid file is normalized to the canonical form of its own definition,
  // and a second pull is stable.
  const compact =
    '{"steps":[{"targets":[{"starter":"starter"}],"key":"start"}],"schemaVersion":1}\n'
  writeFileSync(path, compact)
  expect(enform(['flow', 'pull', 'course-overload'], cwd).status).toBe(0)
  expect(readFileSync(path, 'utf8')).toBe(serialize(parse(compact)))
  const pulled = readFileSync(path, 'utf8')
  expect(enform(['flow', 'pull', 'course-overload'], cwd).status).toBe(0)
  expect(readFileSync(path, 'utf8')).toBe(pulled)
})

test('#38 --json prints machine-readable JSON (S01, DX-3)', () => {
  const result = enform(['flow', 'init', 'course-overload', '--json'], workdir())
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(
    JSON.stringify({ ok: true, slug: 'course-overload', path: 'course-overload.flow.json' })
  )
})
