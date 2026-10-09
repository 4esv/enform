import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// The checks of issue #96: CI runs the complete local check on every pull
// request. The changelog rule and the invariant rule run next to it.

const repo = join(import.meta.dirname, '..')

test('#96 CI runs the complete local check on every pull request', () => {
  const workflow = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8')
  expect(workflow, 'pull_request trigger').toContain('pull_request')
  expect(workflow, 'make setup').toContain('make setup')
  expect(workflow, 'make check').toContain('make check')
  expect(workflow, 'changelog rule').toContain('tools/changelog-rule.mjs')
  expect(workflow, 'invariant rule').toContain('tools/invariant-rule.mjs')
})
