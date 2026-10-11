import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, test } from 'vitest'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import type { Flow } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #177, FM-7, DF-1, I2: the published event schemas match the payloads
// that the engine writes. The schemas are the contract (MVP.md 9.1, ADR 0004):
// a client builds the operation payload from the published schema, so the
// engine's real payload must validate against it, and a payload that breaks
// the shape must be rejected.

const repo = join(import.meta.dirname, '..')
const SLUG = 'course-overload'
const SAM = 'user:sam'

const definition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }]
    }
  ]
}
`)

const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(definition), definition }],
}

const resolve: TargetResolver = (target) => ('starter' in target ? [SAM] : [])

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

const startedValues: ConditionData = { summary: 'hello', urgent: false }
const captured: ConditionData = { summary: 'hello', detail: 'more detail' }

const ajv = new Ajv2020({ logger: false })
const validateStarted = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.started@1.json'), 'utf8'))
)
const validateSubmitted = ajv.compile(
  JSON.parse(readFileSync(join(repo, 'schemas', 'events', 'instance.submitted@1.json'), 'utf8'))
)

test('#177 FM-7 the published event schemas match the payloads the engine writes', () => {
  const started = startInstance(flow, startedValues, SAM, deps(), resolve, grants)
  const submitted = submitInstance(started.instance, SAM, deps(), captured)

  // The real payloads validate against the published schemas (MVP.md 9.1).
  expect(validateStarted(started.operation.payload), 'the start payload validates').toBe(true)
  expect(validateSubmitted(submitted.operation.payload), 'the submit payload validates').toBe(true)

  // A payload that breaks the shape is rejected: the start's values must be a
  // record of field keys to JSON values, and the submit must mark submitted
  // true.
  expect(validateStarted({ ...started.operation.payload, values: 'not a record' })).toBe(false)
  expect(validateSubmitted({ ...submitted.operation.payload, submitted: false })).toBe(false)
})
