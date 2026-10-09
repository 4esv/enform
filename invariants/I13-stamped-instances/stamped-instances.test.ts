// Issue #19, I13, DF-2, AS-4, A8: the stamped instance oracle.
//
// I13: each instance records its definition version and the resolved assignees
// with a membership snapshot. It also records a log of connector calls:
// operation, time and outcome. It does not record response bodies. The oracle
// below states that as a check over one instance, so a story run can call it
// with the instance that its run created (MVP.md 11.4).
//
// Scaffolding for #19: the first check is marked as expected to fail, because
// the engine functions are stubs until the second commit implements them. The
// deliberate violation below already fails the oracle, and it stays marked.

import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { parse, serialize } from '../../engine/definition.js'
import {
  type Assignee,
  type ConnectorCall,
  createInstance,
  type Instance,
  recordConnectorCall,
} from '../../engine/instance.js'

/** A fixed Unix-millisecond time. The clock is injected, so this is the only time (I6). */
const NOW = 1_700_000_000_000

/** A well-formed content hash, for the instance that the violation check builds. */
const VERSION = 'a'.repeat(64)

/** The canonical file of a three-step flow: a dynamic target, a group and a team. */
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
      "key": "approve",
      "targets": [
        {
          "group": "CS-Chairs"
        }
      ],
      "outcomes": [
        "approve",
        "send_back"
      ]
    },
    {
      "key": "register",
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

/**
 * The resolved assignees: the starter's one-time resolution, then the live
 * members of a group and of a team at resolution time (AS-4).
 */
const ASSIGNEES: readonly Assignee[] = [
  { step: 'request', target: { starter: 'starter' }, members: ['person-dana'] },
  { step: 'approve', target: { group: 'CS-Chairs' }, members: ['person-ana', 'person-bao'] },
  { step: 'register', target: { team: 'registrar-office' }, members: ['person-cy'] },
]

/** One connector call: an operation, a time and an outcome. It carries no response body. */
const CALL: ConnectorCall = { operation: 'send-confirmation', time: NOW, outcome: 'sent' }

/**
 * The I13 oracle. Check one instance: it carries the content hash of the
 * definition version that it started on (DF-2), every resolved assignee
 * carries a membership snapshot (AS-4), and every connector call carries an
 * operation, a time and an outcome and no response body (I13). A story run can
 * call it with the instance that its run created (MVP.md 11.4).
 */
function assertStampedInstance(instance: Instance): void {
  expect(instance.definitionVersion, 'the instance has no definition version').toMatch(
    /^[a-f0-9]{64}$/
  )
  for (const assignee of instance.assignees) {
    expect(
      Array.isArray(assignee.members),
      `the assignee for step ${assignee.step} has no membership snapshot`
    ).toBe(true)
  }
  for (const call of instance.connectorCalls) {
    expect(typeof call.operation, 'a connector call has no operation').toBe('string')
    expect(typeof call.time, 'a connector call has no time').toBe('number')
    expect(typeof call.outcome, 'a connector call has no outcome').toBe('string')
    expect(Object.keys(call).sort(), 'a connector call carries more than its outcome').toEqual([
      'operation',
      'outcome',
      'time',
    ])
  }
}

test.fails('#19 an instance is stamped with its version, assignees and calls (I13)', () => {
  const definition = parse(FILE)
  const instance = recordConnectorCall(createInstance(definition, ASSIGNEES), CALL)
  expect(instance.definitionVersion).toBe(
    createHash('sha256').update(serialize(definition)).digest('hex')
  )
  expect(instance.assignees).toEqual(ASSIGNEES)
  expect(instance.connectorCalls).toEqual([CALL])
  assertStampedInstance(instance)
})

/**
 * The deliberate violation of the check above: a connector call that smuggles
 * the response body. I13 records the operation, the time and the outcome, and
 * not the response body. The oracle must fail on the body, and `test.fails`
 * asserts that failure.
 */
test.fails('#19 the oracle fails when a connector call carries a response body (I13)', () => {
  const leaked = {
    operation: 'send-confirmation',
    time: NOW,
    outcome: 'sent',
    body: { to: 'dana@example.org', subject: 'Your request' },
  } as unknown as ConnectorCall
  const instance: Instance = {
    definitionVersion: VERSION,
    assignees: ASSIGNEES,
    connectorCalls: [leaked],
  }
  assertStampedInstance(instance)
})
