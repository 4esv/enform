import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  allowsAnonymous,
  canView,
  type FlowDefinition,
  parse,
  serialize,
} from '../engine/definition.js'
import type { Flow } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance } from '../engine/submission.js'

// Issue #71, ID-3, ID-2, A4, DF-1, I9: anonymous access is an explicit setting
// for each flow. A flow with the default sends a visitor who is not signed in
// to SSO (ID-2). A flow with `anonymous: true` lets that visitor open the form,
// and the definition exposes the setting (ID-3, A4). The setting is a change to
// the flow definition format (DF-1), so the published JSON Schema changes with
// the code, and the canonical file form (DF-4) carries the optional field
// through the round trip (I9). Viewing is not starting: a start still needs a
// signed-in principal (ID-2), so the anonymous setting never creates a draft.
//
// The check is marked as expected to fail until the anonymous setting lands
// (#71, ID-3).

const repo = join(import.meta.dirname, '..')

/** A flow that requires sign-in: it has no anonymous setting (ID-2). */
const privateFlow = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "request",
      "targets": [{ "user": "user:okafor" }]
    }
  ]
}
`)

/** The same flow with the anonymous setting on (ID-3). */
const anonymousFlow = parse(`{
  "schemaVersion": 1,
  "anonymous": true,
  "steps": [
    {
      "key": "request",
      "targets": [{ "user": "user:okafor" }]
    }
  ]
}
`)

/** The directory of the test (ID-4): a user target names its principal. */
const resolve: TargetResolver = (target) => ('user' in target ? [target.user] : [])

/** The published flow of the test, ready for a start at version 1 (DF-2). */
function flowOf(definition: FlowDefinition): Flow {
  return {
    slug: 'course-overload',
    versions: [{ version: 1, contentHash: contentHash(definition), definition }],
  }
}

/** The injected sources of a start (I6): a fixed clock time and one operation ID. */
const deps = { clock: () => 1_700_000_000_000, ids: () => 'op-1' }

test.fails('#71 ID-3 anonymous access is an explicit setting for each flow', () => {
  // (a) The default sends a visitor who is not signed in to SSO (ID-2): the
  // flow does not allow anonymous access, so the visitor cannot view it.
  expect(allowsAnonymous(privateFlow)).toBe(false)
  expect(canView(privateFlow, undefined)).toBe(false)
  expect(canView(privateFlow, 'user:sam')).toBe(true)

  // The setting never creates a draft: a start with no principal is still
  // refused (ID-2).
  expect(() => startInstance(flowOf(privateFlow), {}, undefined, deps, resolve)).toThrow(
    /signed-in principal/
  )

  // (b) With the setting on, a visitor who is not signed in may open the form,
  // and the definition exposes the setting (ID-3, A4).
  expect(anonymousFlow.anonymous).toBe(true)
  expect(allowsAnonymous(anonymousFlow)).toBe(true)
  expect(canView(anonymousFlow, undefined)).toBe(true)

  // (c) Viewing is not starting (ID-3 against ID-2): an anonymous flow still
  // refuses a start with no principal, so the engine never creates a draft
  // without sign-in.
  expect(() => startInstance(flowOf(anonymousFlow), {}, undefined, deps, resolve)).toThrow(
    /signed-in principal/
  )

  // (d) The canonical round trip carries the optional field (I9, DF-4): the
  // canonical file form includes the setting when the definition has it, and
  // omits it otherwise, and parse then serialize reproduces the form.
  expect(serialize(anonymousFlow)).toContain('"anonymous": true')
  expect(serialize(privateFlow)).not.toContain('anonymous')
  expect(parse(serialize(anonymousFlow)).anonymous).toBe(true)
  expect(serialize(parse(serialize(anonymousFlow)))).toBe(serialize(anonymousFlow))

  // A present setting that is not a boolean is refused (DF-1).
  expect(() => parse(`{ "schemaVersion": 1, "anonymous": "yes", "steps": [] }`)).toThrow(
    /anonymous must be a boolean/
  )

  // The published JSON Schema (DF-1) declares the optional boolean setting and
  // keeps its objects closed.
  const schema = JSON.parse(readFileSync(join(repo, 'schemas', 'flow', 'v1.json'), 'utf8'))
  expect(schema.additionalProperties).toBe(false)
  expect(schema.properties.anonymous).toEqual({ type: 'boolean' })
  expect(schema.required).toEqual(['schemaVersion', 'steps'])
})
