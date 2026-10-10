#!/usr/bin/env node
// Issue #18, I12, A3, A9: the interface uses only the public API. The
// interface lives in `interface/`. It may import the generated public API
// client (DX-4) and the engine's public entry, `engine/index.ts`, which
// re-exports the engine's public modules. Every other module under `engine/`
// is an internal module (MVP.md 9.1: "Database tables, internal modules and
// interface markup are not public"), so an import of one from the interface
// is a violation.
//
// Usage: node tools/public-api-rule.mjs [repo]
// The repository defaults to the one that contains this script.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = process.argv[2] ?? join(here, '..')

// The interface directory (I12). It may be absent until the interface starts
// (MVP.md section 8, milestone 0.4.0).
const interfaceDir = join(repo, 'interface')

// The public surface that the interface may import from the engine: the
// engine's public entry, which re-exports the engine's public modules.
const PUBLIC_ENGINE = new Set(['engine/index.ts', 'engine/index.js'])

const files = sourceFiles(interfaceDir)
const failures = []

for (const file of files) {
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
    const fromRepo = relative(repo, resolve(dirname(file), specifier))
      .split(sep)
      .join('/')
    if (!fromRepo.startsWith('engine/')) continue
    if (PUBLIC_ENGINE.has(fromRepo)) continue
    failures.push(`${relative(repo, file)} imports the engine internal ${specifier}`)
  }
}

if (failures.length > 0) {
  console.error('public API rule: the interface uses only the public API (I12, A3, A9):')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`public API rule: the interface imports no engine internal (${files.length} files)`)

// Every module specifier of a source file: `from '...'`, `import '...'` and
// `import('...')`, so that a re-export counts like an import.
function importSpecifiers(text) {
  const found = []
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) found.push(match[1])
  return found
}

// Every source file in a directory, at any depth. A missing directory has no
// files, so the rule passes while the interface does not exist.
function sourceFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) found.push(path)
  }
  return found
}
