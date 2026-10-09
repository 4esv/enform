#!/usr/bin/env node
// Issue #29, STORIES.md Coverage and Traceability: the build writes
// stories/MATRIX.md, the matrix of story, operator and mode, from STORIES.md
// and MVP.md. The operators are the eight of STORIES.md, Fuzzy paths
// (MVP.md 11.4). The modes are the four of STORIES.md, Golden path.
//
// Usage: node tools/matrix.mjs [repo]
// The repository defaults to the one that contains this script. The generator
// writes <repo>/stories/MATRIX.md and prints a one-line summary.
//
// Judgment call: the documents do not state which operator applies to which
// story. STORIES.md says that variation operators generate fuzzy paths from
// each golden path, so every operator applies to every story here. A story
// does not have to run an operator until it is claimed to pass: tools/
// matrix-rule.mjs enforces the operator cells only for a story whose evidence
// status is passing (STORIES.md, Evidence). The mode skip of S07 comes from
// its written **Modes.** line.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The eight variation operators (STORIES.md, Fuzzy paths; MVP.md 11.4).
export const OPERATORS = [
  'Actor',
  'Duplicate',
  'Race',
  'Fault',
  'Offline',
  'Clock',
  'Data',
  'Version',
]
// The four run modes (STORIES.md, Golden path).
export const MODES = ['api', 'cli', 'dry', 'gui']
// The milestone whose requirements are in scope for coverage (MVP.md section
// 8). tools/invariant-rule.mjs reads the invariants of the same row.
export const CURRENT_MILESTONE = '0.1.0'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = process.argv[2] ?? join(here, '..')

// Every ID of MVP.md that a story may cite: A1, I1, ID-1 and D1 (section 2,
// 4, 5 and 12). The tables use `| ID | ... |`.
export function knownIds(mvp) {
  const ids = new Set()
  for (const line of mvp.split('\n')) {
    const match = line.match(/^\|\s*(A\d+|I\d+|[A-Z]{2}-\d+|D\d+)\s*\|/)
    if (match) ids.add(match[1])
  }
  return ids
}

// The requirements of the current milestone row (MVP.md section 8).
export function inScopeRequirements(mvp) {
  return [...milestoneRow(mvp, CURRENT_MILESTONE).matchAll(/[A-Z]{2}-\d+/g)].map((m) => m[0])
}

function milestoneRow(mvp, version) {
  const marker = `| \`${version}\` |`
  for (const line of mvp.split('\n')) {
    if (line.startsWith(marker)) return line
  }
  return ''
}

// The stories of STORIES.md. A story heading is `### S01: Title (\`slug\`)`.
export function parseStories(text) {
  const parts = text.split(/^### (S\d{2}): /m)
  const stories = []
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i]
    const body = parts[i + 1]
    const firstLine = body.split('\n', 1)[0].trim()
    const heading = firstLine.match(/^(.+?) \(`([^`]+)`\)$/)
    const refs = body.match(/^\*\*Refs\.\*\* (.+)$/m)
    const modes = body.match(/^\*\*Modes\.\*\* (.+)$/m)
    stories.push({
      id,
      title: heading ? heading[1] : firstLine,
      slug: heading ? heading[2] : '',
      refs: refs ? expandIds(refs[1]) : [],
      rawRefs: refs ? refs[1] : '',
      modesLine: modes ? modes[1] : '',
    })
  }
  return stories
}

// The status column of the Evidence table, keyed by story ID.
export function evidenceStatus(text) {
  const statuses = new Map()
  for (const line of text.split('\n')) {
    const match = line.match(/^\|\s*(S\d{2})\s*\|/)
    if (!match) continue
    const cells = line.split('|').map((cell) => cell.trim())
    statuses.set(match[1], cells[cells.length - 2] ?? '')
  }
  return statuses
}

// Expand `AC-1 to AC-4` and plain IDs into a list (check_charter.py does the
// same). An ID is two letters and a number, a single letter and a number, or a
// range of either.
export function expandIds(text) {
  const ids = []
  for (const match of text.matchAll(/([A-Z]{2}-\d+|[AID]\d+)(?: to ([A-Z]{2}-\d+|[AID]\d+))?/g)) {
    const [, first, last] = match
    if (!last) {
      ids.push(first)
      continue
    }
    const from = first.match(/^([A-Z]+-?)(\d+)$/)
    const to = last.match(/^([A-Z]+-?)(\d+)$/)
    if (from[1] !== to[1]) {
      ids.push(first)
      continue
    }
    for (let n = Number(from[2]); n <= Number(to[2]); n += 1) ids.push(`${from[1]}${n}`)
  }
  return ids
}

// The modes that a `**Modes.**` line skips, each with the written reason. The
// first sentence declares the skip; the rest is the reason.
export function parseModes(line) {
  if (!line) return []
  const modes = [...line.matchAll(/`(api|cli|dry|gui)`/g)].map((match) => match[1])
  const reason = line.split(/\.\s+/).slice(1).join('. ').trim()
  return [...new Set(modes)].map((mode) => ({ mode, reason }))
}

// The text of a story suite (`stories/S<id>-<slug>/`), or null when the suite
// does not exist yet. The text shows which operators and modes it exercises.
export function suiteText(repoPath, story) {
  const dir = join(repoPath, 'stories', `${story.id}-${story.slug}`)
  if (!existsSync(dir)) return null
  const files = []
  collectTestFiles(dir, files)
  if (files.length === 0) return null
  return files.map((file) => readFileSync(file, 'utf8')).join('\n')
}

function collectTestFiles(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectTestFiles(path, found)
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
}

// A story suite runs an operator when it names the operator. The naming
// convention is the capitalized name, for example "#31 the Duplicate operator"
// (case-sensitive, so a comment about an event actor does not count).
export function operatorRuns(text, operator) {
  if (!text) return false
  return new RegExp(`\\b${operator}\\b`).test(text)
}

// A mode runs for a story when the suite shows it. The api mode is the default
// runner, so it runs once the suite exists; cli, dry and gui arrive with their
// own harness work and show in the suite only then.
export function modeRuns(text, mode) {
  if (!text) return false
  if (mode === 'api') return true
  return new RegExp(`\\b${mode}\\b`, 'i').test(text)
}

// Read the documents and the story suites into one model.
export function build(repoPath) {
  const mvp = readFileSync(join(repoPath, 'MVP.md'), 'utf8')
  const stories = readFileSync(join(repoPath, 'STORIES.md'), 'utf8')
  const parsed = parseStories(stories)
  return {
    mvp,
    stories: parsed,
    statuses: evidenceStatus(stories),
    known: knownIds(mvp),
    inScope: inScopeRequirements(mvp),
    suites: new Map(parsed.map((story) => [story.id, suiteText(repoPath, story)])),
  }
}

// Render stories/MATRIX.md (STORIES.md, Coverage; Traceability).
export function renderMatrix(model) {
  const { stories, suites, inScope } = model
  const lines = []
  lines.push('# Story coverage matrix')
  lines.push('')
  lines.push(
    'Generated by `node tools/matrix.mjs` from `STORIES.md` and `MVP.md` (STORIES.md, Coverage). Do not edit this file by hand.'
  )
  lines.push('')
  lines.push(
    'The operators are the eight of STORIES.md, Fuzzy paths (Actor, Duplicate, Race, Fault, Offline, Clock, Data, Version). The modes are the four of STORIES.md, Golden path (api, cli, dry, gui). Every operator applies to every story.'
  )
  lines.push('')
  lines.push('- `run`: the story suite exercises the operator in a mode that runs.')
  lines.push('- `-`: the operator applies, but nothing exercises it yet.')
  lines.push(
    '- `skip`: the story writes why the cell does not run; the reason is under Skipped cells.'
  )
  lines.push('')

  for (const story of stories) {
    const text = suites.get(story.id)
    const skipped = new Set(parseModes(story.modesLine).map((entry) => entry.mode))
    lines.push(`## ${story.id}: ${story.title} (\`${story.slug}\`)`)
    lines.push('')
    lines.push(`Refs: ${story.rawRefs || '-'}`)
    lines.push('')
    lines.push('| Operator | api | cli | dry | gui |')
    lines.push('|---|---|---|---|---|')
    for (const operator of OPERATORS) {
      const cells = MODES.map((mode) => {
        if (skipped.has(mode)) return 'skip'
        if (modeRuns(text, mode) && operatorRuns(text, operator)) return 'run'
        return '-'
      })
      lines.push(`| ${operator} | ${cells.join(' | ')} |`)
    }
    lines.push('')
  }

  lines.push('## Skipped cells')
  lines.push('')
  const skips = []
  for (const story of stories) {
    for (const { mode, reason } of parseModes(story.modesLine)) {
      skips.push(`- ${story.id} \`${mode}\`: ${reason || 'NO REASON WRITTEN'}`)
    }
  }
  lines.push(...(skips.length > 0 ? skips : ['- none']))
  lines.push('')

  lines.push(`## In-scope requirements (MVP.md section 8, \`${CURRENT_MILESTONE}\`)`)
  lines.push('')
  lines.push('| Requirement | Cited by |')
  lines.push('|---|---|')
  for (const requirement of inScope) {
    const cited = stories
      .filter((story) => story.refs.includes(requirement))
      .map((story) => story.id)
    lines.push(`| ${requirement} | ${cited.join(', ') || '-'} |`)
  }
  lines.push('')

  return lines.join('\n')
}

// Write stories/MATRIX.md, and only touch the file when the content changes.
export function writeMatrix(repoPath, content) {
  const target = join(repoPath, 'stories', 'MATRIX.md')
  if (existsSync(target) && readFileSync(target, 'utf8') === content) return false
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const model = build(repo)
  writeMatrix(repo, renderMatrix(model))
  const suites = [...model.suites.values()].filter((text) => text !== null).length
  console.log(
    `matrix: wrote stories/MATRIX.md for ${model.stories.length} stories (${suites} with a suite)`
  )
}
