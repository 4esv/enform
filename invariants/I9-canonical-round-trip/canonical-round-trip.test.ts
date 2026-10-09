// Issue #15, I9, A3: the canonical round trip oracle.
//
// I9: conversion of a definition from file to operations and back to file
// gives an identical file, byte for byte. The oracle below states that as a
// check over one definition file. A story run can call it with the file that
// it pulled (MVP.md 11.4).

import { expect, test } from 'vitest'
import {
  definitionFromOperation,
  definitionToOperation,
  type FlowDefinition,
  parse,
  serialize,
} from '../../engine/definition.js'

/** A fixed Unix-millisecond time. The clock is injected, so this is the only time (I6). */
const NOW = 1_700_000_000_000

/** The injected sources for the operation that records the definition (I6). */
const deps = { clock: () => NOW, ids: () => 'op-1' }

/** The canonical file of the pilot flow `course-overload` (STORIES.md, S05). */
const FILE = `{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "request",
      "targets": [
        {
          "starter": "starter"
        }
      ]
    },
    {
      "key": "advisor",
      "targets": [
        {
          "field": "advisor"
        }
      ],
      "outcomes": [
        "approve",
        "send_back"
      ]
    },
    {
      "key": "chair",
      "targets": [
        {
          "group": "CS-Chairs"
        }
      ],
      "outcomes": [
        "approve",
        "send_back"
      ],
      "skipWhen": {
        "<=": [
          {
            "var": "overload_credits"
          },
          2
        ]
      }
    },
    {
      "key": "registrar",
      "targets": [
        {
          "team": "registrar-office"
        }
      ],
      "outcomes": [
        "approve",
        "reject"
      ]
    }
  ]
}
`

/** The same definition with its keys out of canonical order, so it is not a canonical file. */
const NON_CANONICAL = `{
  "steps": [
    {
      "targets": [
        {
          "starter": "starter"
        }
      ],
      "key": "request"
    }
  ],
  "schemaVersion": 1
}
`

/**
 * The I9 oracle. Parse one definition file, then serialize the definition, and
 * require the same bytes back (I9). A story run can call it with the file that
 * it pulled (MVP.md 11.4).
 */
function assertCanonicalRoundTrip(file: string): FlowDefinition {
  const definition = parse(file)
  expect(serialize(definition)).toBe(file)
  return definition
}

test.fails('#15 parse then serialize reproduces a canonical file byte for byte (I9)', () => {
  assertCanonicalRoundTrip(FILE)
})

test('#15 a definition round-trips through a config.definition.changed@1 operation (I9)', () => {
  const definition = parse(FILE)
  const operation = definitionToOperation(definition, deps)
  expect(operation.type).toBe('config.definition.changed@1')
  expect(operation.actor).toBeUndefined()
  expect(definitionFromOperation(operation)).toEqual(definition)
})

/**
 * The deliberate violation of the first check: a file whose keys are out of
 * canonical order. `serialize(parse(file))` reorders the keys, so the bytes do
 * not match, and the oracle fails. `test.fails` asserts that failure.
 */
test.fails('#15 the oracle fails on a file whose keys are not canonical (I9)', () => {
  assertCanonicalRoundTrip(NON_CANONICAL)
})
