#!/usr/bin/env node
// Issue #29, STORIES.md Coverage and Traceability. CI fails when:
//   (a) an in-scope requirement has no story and no requirement test,
//   (b) a story that is claimed to pass does not run an operator that applies
//       to it,
//   (c) a matrix cell is skipped without a written reason in the story,
//   (d) a story cites an unknown ID.
// It also fails when stories/MATRIX.md is not the output of tools/matrix.mjs,
// so the committed matrix stays honest.
//
// Usage: node tools/matrix-rule.mjs [repo]
// The repository defaults to the one that contains this script.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, OPERATORS, operatorRuns, parseModes, renderMatrix } from './matrix.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = process.argv[2] ?? join(here, '..')
const IGNORED = new Set(['node_modules', '.git', '.orchestrator', '.pi', '.vitest'])

const model = build(repo)
const failures = []

// (d) A story cites an ID that MVP.md does not define.
for (const story of model.stories) {
  for (const id of story.refs) {
    if (!model.known.has(id)) failures.push(`${story.id} cites an unknown ID: ${id}`)
  }
}

// (a) An in-scope requirement with no story and no requirement test. A
// requirement that no story cites is complete when its requirement test passes
// (MVP.md section 13, the #99 entry).
for (const requirement of model.inScope) {
  if (model.stories.some((story) => story.refs.includes(requirement))) continue
  if (requirementTest(repo, requirement)) continue
  failures.push(`in-scope requirement ${requirement} has no story and no requirement test`)
}

// (b) A story that is claimed to pass must run every operator that applies to
// it. A story before that point is not complete (STORIES.md, Evidence).
const PASSING = /passes|Done/i
for (const story of model.stories) {
  const status = model.statuses.get(story.id) ?? ''
  if (!PASSING.test(status)) continue
  const text = model.suites.get(story.id)
  for (const operator of OPERATORS) {
    if (!operatorRuns(text, operator)) {
      failures.push(`${story.id} is ${status} but does not run the ${operator} operator`)
    }
  }
}

// (c) A skipped matrix cell needs a written reason in the story.
for (const story of model.stories) {
  for (const { mode, reason } of parseModes(story.modesLine)) {
    if (reason.trim() === '') {
      failures.push(`${story.id}: the ${mode} cell is skipped without a written reason`)
    }
  }
}

// The committed matrix must be current.
const matrixPath = join(repo, 'stories', 'MATRIX.md')
const expected = renderMatrix(model)
if (!existsSync(matrixPath) || readFileSync(matrixPath, 'utf8') !== expected) {
  failures.push('stories/MATRIX.md is not current; run node tools/matrix.mjs')
}

if (failures.length > 0) {
  console.error('matrix rule: STORIES.md Coverage (MVP.md 11.4) fails:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(
  `matrix rule: ${model.stories.length} stories, ${model.inScope.length} in-scope requirements, ${OPERATORS.length} operators`
)

// A requirement test is a test named for the requirement ID (compare the DX-1
// test in tools/openapi.test.ts). The scan reads the test titles, not comments.
function requirementTest(repoPath, id) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9-])${id.replace('-', '\\-')}([^A-Za-z0-9-]|$)`)
  for (const file of testFiles(repoPath)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\b(?:test|it|describe)(?:\.\w+)?\(\s*(['"`])([^'"`]*)\1/g)) {
      if (pattern.test(match[2])) return file
    }
  }
  return null
}

function testFiles(dir) {
  const found = []
  walk(dir, found)
  return found
}

function walk(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, found)
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
}
