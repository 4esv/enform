import { expect, test } from 'vitest'
import { parse } from '../engine/definition.js'
import type { TargetResolver } from '../engine/routing.js'

// Issue #264, DR-1, DR-3, DR-4, DR-5, S05, S08, S12, I6, I7: the dry run of
// a definition. It routes the data through the steps, names the steps a
// condition skipped with the condition, resolves who each active step goes
// to and why (the target and its members), previews the assignment emails
// of the first step as the inbox a live submit would fill, and, with the
// simulated clock moved forward, the reminders and the escalation that the
// first step fires by then. It is pure and deterministic (I6): it reads the
// injected directory and the given time, writes no event and sends nothing.

type DryRun = {
  dryRun: (options: {
    definition: unknown
    data: Record<string, unknown>
    actor: string
    resolve: TargetResolver
    now: number
    advanceMs?: number
    instanceId?: string
  }) => {
    route: { active: readonly string[]; skipped: readonly { step: string; condition: unknown }[] }
    assignees: readonly { step: string; target: unknown; members: readonly string[] }[]
    next?: string
    intents: readonly { operation: string; payload: Record<string, unknown> }[]
    timers: readonly { step: string; kind: string; fireAt: number; fired: boolean }[]
  }
}

const DRYRUN_MODULE = new URL('../engine/dryrun.js', import.meta.url).href

async function dryrun(): Promise<DryRun> {
  return (await import(DRYRUN_MODULE)) as unknown as DryRun
}

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "overload_credits", "control": "number" }, { "key": "advisor", "control": "user" }]
    },
    {
      "key": "advisor",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve"],
      "reminderMinutes": 1440,
      "deadlineMinutes": 4320,
      "escalationTargets": [{ "group": "CS-Chairs" }]
    },
    {
      "key": "chair",
      "targets": [{ "group": "CS-Chairs" }],
      "outcomes": ["approve"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    },
    { "key": "registrar", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] }
  ]
}
`)

const resolve: TargetResolver = (target) => {
  if ('starter' in target) return ['user:sam']
  if ('user' in target) return [target.user]
  if ('field' in target) return ['user:okafor']
  if ('group' in target) return ['user:lin']
  if ('team' in target) return ['user:lee', 'user:ana']
  return []
}

const DAY = 24 * 60 * 60_000

test('#264 DR-1 S05 S08 a dry run routes the data, names the skipped step with its condition, and explains who each step goes to', async () => {
  const { dryRun } = await dryrun()
  const small = dryRun({
    definition,
    data: { overload_credits: 2, advisor: 'user:okafor' },
    actor: 'user:sam',
    resolve,
    now: 1_000,
  })
  expect(small.route.active).toEqual(['request', 'advisor', 'registrar'])
  expect(small.route.skipped).toEqual([
    { step: 'chair', condition: { '<=': [{ var: 'overload_credits' }, 2] } },
  ])
  // Who each active step resolves to, and why (S08): the target and its members.
  expect(small.assignees).toEqual([
    { step: 'request', target: { starter: 'starter' }, members: ['user:sam'] },
    { step: 'advisor', target: { field: 'advisor' }, members: ['user:okafor'] },
    { step: 'registrar', target: { team: 'registrar-office' }, members: ['user:lee', 'user:ana'] },
  ])
  // The first step after the request form is where a submit routes; its
  // assignment email is the preview inbox (DR-3), and nothing is sent.
  expect(small.next).toBe('advisor')
  expect(small.intents).toEqual([
    {
      operation: 'send-assignment',
      target: 'connector-smtp',
      payload: { to: 'user:okafor', step: 'advisor' },
    },
  ])
  const large = dryRun({
    definition,
    data: { overload_credits: 4, advisor: 'user:okafor' },
    actor: 'user:sam',
    resolve,
    now: 1_000,
  })
  expect(large.route.active).toEqual(['request', 'advisor', 'chair', 'registrar'])
  expect(large.route.skipped).toEqual([])
})

test('#264 DR-4 S12 a simulated clock moved forward fires the reminders and the escalation of the first step', async () => {
  const { dryRun } = await dryrun()
  const data = { overload_credits: 2, advisor: 'user:okafor' }
  const base = { definition, data, actor: 'user:sam', resolve, now: 1_000 }
  const oneDay = dryRun({ ...base, advanceMs: DAY })
  // The advisor step reminds every day and escalates after three: one day on,
  // exactly one reminder fired and the escalation has not (SE-3).
  expect(oneDay.timers.map((timer) => [timer.kind, timer.fired])).toEqual([
    ['reminder', true],
    ['reminder', false],
    ['reminder', false],
    ['escalation', false],
  ])
  expect(oneDay.timers[0]?.fireAt).toBe(1_000 + DAY)
  expect(oneDay.intents.map((intent) => intent.operation)).toEqual([
    'send-assignment',
    'send-reminder',
  ])
  const threeDays = dryRun({ ...base, advanceMs: 3 * DAY })
  expect(threeDays.timers.filter((timer) => timer.fired).map((timer) => timer.kind)).toEqual([
    'reminder',
    'reminder',
    'reminder',
    'escalation',
  ])
  expect(threeDays.intents.map((intent) => intent.operation)).toEqual([
    'send-assignment',
    'send-reminder',
    'send-reminder',
    'send-reminder',
    'send-escalation',
  ])
  // Without a clock move nothing fires, and a step without timers has none.
  expect(dryRun(base).timers.every((timer) => !timer.fired)).toBe(true)
})
