import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse, serialize } from '../engine/definition.js'
import { contentHash } from '../engine/instance.js'

// Issue #38, S01, DF-1, DF-2, DF-4, DF-6, DX-3, DR-1, I6, I7, I9: the `enform`
// flow commands. The checks run the bin as a user would, so they cover the
// dispatch, the exit codes and the `--json` output together. `init` writes a
// canonical file (DF-1), `validate` rejects an invalid file and changes
// nothing (DF-1), `pull` reproduces the canonical file byte for byte (DF-4,
// I9), `push` stores the draft equal to the file (DF-4), `publish` freezes an
// immutable version with a content hash (DF-2), `diff` names the change (DF-6)
// and `dry-run` reports the route and the side-effect intents without writing
// an event (DR-1, I7). The output is deterministic (I6).

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

/** The local `.enform/<slug>.json` store, as the CLI writes it (DF-1, DF-4). */
type StoredFlow = {
  readonly slug: string
  readonly draft?: unknown
  readonly versions: readonly { version: number; contentHash: string; definition: unknown }[]
}

/** Read the store file that the CLI writes for one flow. */
function storedFlow(cwd: string, slug: string): StoredFlow {
  return JSON.parse(readFileSync(join(cwd, '.enform', `${slug}.json`), 'utf8'))
}

/** A two-step flow; the advisor step is skipped when the data says so (WF-1). */
const TWO_STEP = `{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "skipWhen": { "var": "skip_advisor" } }
  ]
}
`

/** The same flow with the chair step added, a structural change (DF-6). */
const THREE_STEP = `{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "skipWhen": { "var": "skip_advisor" } },
    { "key": "chair", "targets": [{ "group": "CS-Chairs" }] }
  ]
}
`

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

test('#38 flow push stores the draft equal to the file (S01, DF-4, I9)', () => {
  const cwd = workdir()
  const file = 'course-overload.flow.json'
  writeFileSync(join(cwd, file), TWO_STEP)
  const result = enform(['flow', 'push', file, '--json'], cwd)
  expect(result.status, result.stderr).toBe(0)

  const flow = storedFlow(cwd, 'course-overload')
  // The draft equals the pushed file, read by the engine (DF-4).
  expect(flow.draft).toEqual(parse(TWO_STEP))
  // The first push opens a draft and publishes nothing (DF-1, DF-2).
  expect(flow.versions).toEqual([])
  // The stored draft is canonical: parse then serialize round trips (I9).
  expect(flow.draft).toEqual(JSON.parse(serialize(parse(TWO_STEP))))
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, slug: 'course-overload', path: file })
})

test('#38 flow publish freezes an immutable version with a content hash (S01, DF-2)', () => {
  const cwd = workdir()
  const file = 'course-overload.flow.json'
  writeFileSync(join(cwd, file), TWO_STEP)
  expect(enform(['flow', 'push', file], cwd).status).toBe(0)

  const result = enform(['flow', 'publish', 'course-overload', '--json'], cwd)
  expect(result.status, result.stderr).toBe(0)
  const out = JSON.parse(result.stdout)
  expect(out.version).toBe(1)
  expect(out.contentHash).toBe(contentHash(parse(TWO_STEP)))

  const published = storedFlow(cwd, 'course-overload')
  expect(published.versions).toHaveLength(1)
  expect(published.versions[0].version).toBe(1)
  expect(published.versions[0].contentHash).toBe(contentHash(parse(TWO_STEP)))
  expect(published.versions[0].definition).toEqual(parse(TWO_STEP))

  // A later push opens a new draft; version 1 does not change (DF-2).
  writeFileSync(join(cwd, file), THREE_STEP)
  expect(enform(['flow', 'push', file], cwd).status).toBe(0)
  const next = storedFlow(cwd, 'course-overload')
  expect(next.draft).toEqual(parse(THREE_STEP))
  expect(next.versions).toEqual(published.versions)
})

test('#38 flow diff names the change from a version to the draft (S01, DF-6)', () => {
  const cwd = workdir()
  const file = 'course-overload.flow.json'
  writeFileSync(join(cwd, file), TWO_STEP)
  expect(enform(['flow', 'push', file], cwd).status).toBe(0)
  expect(enform(['flow', 'publish', 'course-overload'], cwd).status).toBe(0)

  // The draft adds the chair step, so the change from version 1 names it.
  writeFileSync(join(cwd, file), THREE_STEP)
  expect(enform(['flow', 'push', file], cwd).status).toBe(0)
  const toDraft = enform(
    ['flow', 'diff', 'course-overload', '--from', '1', '--to', 'draft', '--json'],
    cwd
  )
  expect(toDraft.status, toDraft.stderr).toBe(0)
  expect(JSON.parse(toDraft.stdout).changes).toEqual([
    { class: 'structural', message: 'a step was added: chair' },
  ])

  // Publishing the draft makes version 2, and version 1 to version 2 differs.
  expect(enform(['flow', 'publish', 'course-overload'], cwd).status).toBe(0)
  const between = enform(['flow', 'diff', 'course-overload', '--from', '1', '--to', '2'], cwd)
  expect(between.status, between.stderr).toBe(0)
  expect(between.stdout).toContain('structural: a step was added: chair')

  // The draft equals version 2, so that difference is empty (DF-6).
  const same = enform(
    ['flow', 'diff', 'course-overload', '--from', '2', '--to', 'draft', '--json'],
    cwd
  )
  expect(JSON.parse(same.stdout).changes).toEqual([])
})

test('#38 flow dry-run reports the route and intents and writes no event (S01, DR-1, I7)', () => {
  const cwd = workdir()
  const file = 'course-overload.flow.json'
  writeFileSync(join(cwd, file), TWO_STEP)
  expect(enform(['flow', 'push', file], cwd).status).toBe(0)
  writeFileSync(join(cwd, 'sam.json'), '{"skip_advisor": true}')
  const store = join(cwd, '.enform', 'course-overload.json')
  const before = readFileSync(store)

  const result = enform(
    ['flow', 'dry-run', 'course-overload', '--data', 'sam.json', '--as', 'sam', '--json'],
    cwd
  )
  expect(result.status, result.stderr).toBe(0)
  const out = JSON.parse(result.stdout)
  expect(out.actor).toBe('sam')
  expect(out.route.active).toEqual(['request'])
  expect(out.route.skipped).toEqual([{ step: 'advisor', condition: { var: 'skip_advisor' } }])
  expect(out.intents).toEqual([])
  // The dry run writes no event and changes nothing (A6, I7).
  expect(readFileSync(store)).toEqual(before)

  // The run is deterministic (I6): the same data gives the same output.
  const again = enform(
    ['flow', 'dry-run', 'course-overload', '--data', 'sam.json', '--as', 'sam', '--json'],
    cwd
  )
  expect(again.stdout).toBe(result.stdout)
})
