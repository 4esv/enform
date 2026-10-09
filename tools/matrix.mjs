#!/usr/bin/env node
// Issue #29, STORIES.md Coverage and Traceability: the build writes
// stories/MATRIX.md, the matrix of story, operator and mode, from STORIES.md
// and MVP.md. Scaffolding: it writes only the header; the real matrix lands in
// the implementation commit.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = process.argv[2] ?? join(here, '..')

export function renderMatrix() {
  return '# Story coverage matrix\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = join(repo, 'stories', 'MATRIX.md')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderMatrix())
  console.log('matrix: wrote stories/MATRIX.md (scaffold)')
}
