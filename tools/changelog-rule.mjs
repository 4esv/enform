#!/usr/bin/env node
// Issue #96, MVP.md 9.5: a pull request that contains a feat, fix or perf
// commit, or a breaking change, must add an entry under Unreleased in
// CHANGELOG.md.
//
// Usage: node tools/changelog-rule.mjs <git-range>
// The range is the commits of the pull request, for example
// `origin/main..HEAD`. CI passes it. CHANGELOG_RANGE does the same.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dirname, '..')
const range = process.argv[2] ?? process.env.CHANGELOG_RANGE ?? ''

if (range === '') {
  console.error('usage: node tools/changelog-rule.mjs <git-range>')
  process.exit(2)
}

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

function subjects(extra) {
  return git('log', '--format=%s', ...extra, range)
    .split('\n')
    .filter((line) => line.trim() !== '')
}

// `feat:`, `fix(ui):`, `perf!:` and the like (MVP.md 9.6).
const notable = /^(feat|fix|perf)(\([^)]*\))?!?:/
// Any type with the breaking-change mark, for example `chore(api)!:`.
const breaking = /^[a-z]+(\([^)]*\))?!:/

const serious = subjects([]).filter((line) => notable.test(line) || breaking.test(line))
const breakingFooter = subjects(['--grep=^BREAKING CHANGE:'])

if (serious.length === 0 && breakingFooter.length === 0) {
  console.log(`changelog rule: no feat, fix, perf or breaking change in ${range}`)
  process.exit(0)
}

const entries = unreleasedEntries(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'))

if (entries.length > 0) {
  console.log(`changelog rule: ${entries.length} entry under Unreleased in CHANGELOG.md`)
  process.exit(0)
}

console.error('changelog rule: CHANGELOG.md has no entry under Unreleased:')
console.error('these commits need one:')
const reported = new Set(serious)
for (const line of serious) console.error(`  ${line}`)
for (const line of breakingFooter) {
  if (!reported.has(line)) console.error(`  ${line} (BREAKING CHANGE)`)
}
console.error(`range: ${range}`)
process.exit(1)

// The list items between `## [Unreleased]` and the next `## ` heading.
function unreleasedEntries(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('## [Unreleased]'))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  const body = end === -1 ? rest : rest.slice(0, end)
  return body.filter((line) => /^- \S/.test(line))
}
