import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { expect, test } from 'vitest'

// Issue #260, DX-2, RT-1, RT-2, ADR 0006: the realtime protocol is a
// published message schema. Every message kind that the server or the
// client sends validates against `schemas/realtime/v1.json`, and a message
// that names no version, no scope or an unknown type does not, so the two
// sides cannot drift from the published contract.

const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'schemas', 'realtime', 'v1.json'), 'utf8')
)

/** One example of every message kind of version 1 (DX-2). */
const EXAMPLES: readonly Record<string, unknown>[] = [
  { type: 'hello', protocol: 1 },
  { type: 'subscribe', instance: 'inst-1' },
  { type: 'unsubscribe', flow: 'course-overload' },
  { type: 'presence', flow: 'course-overload', where: '/steps/request/fields/summary' },
  { type: 'ping' },
  { type: 'welcome', protocol: 1, principal: { id: 'user:sam', displayName: 'Sam' }, seq: 12 },
  { type: 'reload', supported: [1], reason: 'the server speaks versions 1' },
  { type: 'subscribed', instance: 'inst-1', seq: 12 },
  { type: 'refused', instance: 'inst-2', reason: 'not readable' },
  { type: 'changed', seq: 13, eventType: 'step.claimed@1', instance: 'inst-1' },
  { type: 'changed', seq: 14, eventType: 'config.definition.published@1', flow: 'course-overload' },
  {
    type: 'presence',
    instance: 'inst-1',
    people: [
      { id: 'user:lee', displayName: 'Lee' },
      { id: 'user:ana', displayName: 'Ana' },
    ],
  },
  { type: 'pong' },
]

test('#260 DX-2 every realtime message kind validates against schemas/realtime/v1.json', () => {
  const ajv = new Ajv2020({ strictRequired: false, allErrors: true, logger: false })
  const validate = ajv.compile(schema)
  for (const example of EXAMPLES) {
    expect(
      validate(example),
      `${JSON.stringify(example)}: ${ajv.errorsText(validate.errors)}`
    ).toBe(true)
  }
  // A hello without a version, a subscription without a scope, a change with a
  // payload and an unknown kind are not messages of the protocol.
  for (const bad of [
    { type: 'hello' },
    { type: 'subscribe' },
    { type: 'subscribe', instance: 'a', flow: 'b' },
    { type: 'changed', seq: 1, eventType: 'x', payload: {} },
    { type: 'cursor', where: 'x' },
  ]) {
    expect(validate(bad), JSON.stringify(bad)).toBe(false)
  }
})
