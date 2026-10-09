#!/usr/bin/env node
// Issue #96, MVP.md section 4: CI fails if an invariant has no suite, or if a
// suite is skipped. The suite names are the Suite column of the table in
// section 4, for example `invariants/I1-idempotent-ops`.
//
// Usage: node tools/invariant-rule.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const repo = join(import.meta.dirname, '..')
const table = invariantTable(readFileSync(join(repo, 'MVP.md'), 'utf8'))

const expected = Array.from({ length: 16 }, (_, i) => `I${i + 1}`)
const missingId = expected.filter((id) => !table.some((row) => row.id === id))
const missing = []
const skipped = []

for (const { id, suite } of table) {
  const dir = join(repo, suite)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    missing.push(`${id}: ${suite} is not a directory`)
    continue
  }
  const files = testFiles(dir)
  if (files.length === 0) {
    missing.push(`${id}: ${suite} has no test file`)
    continue
  }
  for (const file of files) {
    if (hasSkip(readFileSync(file, 'utf8'))) skipped.push(relative(repo, file))
  }
}

let failed = false

if (missingId.length > 0) {
  failed = true
  console.error('invariant rule: the table of MVP.md section 4 has no suite for:')
  for (const id of missingId) console.error(`  ${id}`)
}

if (missing.length > 0) {
  failed = true
  console.error('invariant rule: an invariant has no suite (MVP.md section 4):')
  for (const line of missing) console.error(`  ${line}`)
}

if (skipped.length > 0) {
  failed = true
  console.error('invariant rule: a suite is skipped:')
  for (const file of skipped) console.error(`  ${file}`)
}

if (failed) process.exit(1)

console.log(`invariant rule: ${table.length} invariant suites present and not skipped`)

// The rows of the table in MVP.md section 4: `| I1 | ... | A2, A7 | `suite` |`.
function invariantTable(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!/^\|\s*I\d+\s*\|/.test(line)) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const suite = (cells[4] ?? '').replaceAll('`', '').trim()
    if (suite.startsWith('invariants/')) rows.push({ id: cells[1], suite })
  }
  return rows
}

// Every test file in a suite, at any depth.
function testFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(path))
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

// A suite is skipped when it is turned off, with `.skip`, `.todo` or an x-form.
function hasSkip(text) {
  return /\.skip\(|\.todo\(|\bxit\(|\bxdescribe\(|\bxtest\(/.test(text)
}
