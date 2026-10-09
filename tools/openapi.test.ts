import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Validator } from '@seriousme/openapi-schema-validator'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

// Issue #91, DX-1, A3, MVP.md 9.1 and 11.2: the OpenAPI document is the HTTP
// API contract, and its path prefix is /api/v1. The document is a public
// surface (MVP.md 9.1), so this check reads it the way a client does: it
// parses the YAML, validates it against the OpenAPI 3.1 schema, and states the
// operations that the engine serves. The check is marked as expected to fail
// until api/openapi.yaml describes that surface (MVP.md 11.1).

const repo = join(import.meta.dirname, '..')
const documentPath = join(repo, 'api', 'openapi.yaml')

// The 0.1.0 HTTP API: append an operation, read the log, read the rebuilt
// state (issue #91, DX-1). Configuration changes are operations whose type is
// `config.<kind>.changed@1` (I14), not a separate endpoint.
const operations = [
  ['/api/v1/operations', 'post'],
  ['/api/v1/log', 'get'],
  ['/api/v1/state', 'get'],
] as const

test.fails('#91 DX-1 api/openapi.yaml is valid OpenAPI 3.1 for /api/v1', async () => {
  const document = parse(readFileSync(documentPath, 'utf8'))
  expect(document, 'parses as a YAML mapping').toBeTypeOf('object')
  expect(document.openapi, 'declares OpenAPI 3.1').toMatch(/^3\.1\./)

  const validator = new Validator()
  const result = await validator.validate(document)
  expect(result.valid, JSON.stringify(result.errors)).toBe(true)
  expect(validator.version, 'validates as OpenAPI 3.1').toBe('3.1')

  const paths: Record<string, Record<string, unknown>> = document.paths
  for (const path of Object.keys(paths)) {
    expect(path, `${path} is under the /api/v1 prefix`).toMatch(/^\/api\/v1(\/|$)/)
  }
  for (const [path, method] of operations) {
    expect(paths[path], `${method.toUpperCase()} ${path} exists`).toBeDefined()
    expect(paths[path]?.[method], `${method.toUpperCase()} ${path} is declared`).toBeDefined()
  }
})
