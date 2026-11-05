import { expect, test } from 'vitest'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { addGrant } from '../engine/grants.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #256, I8, I4, VT-5, VT-6, S16, DX-3: the log read is authorized. A
// principal reads the events of the instances it may read (its own, the ones
// it is assigned to, the flows it holds instance.read on), the configuration
// changes of the flows it holds instance.timeline on, and everything with
// org.grants on org. A draft's events stay private to its starter, and a
// filter by instance and a limit serve `enform log --instance <id> --limit 5`.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const OKAFOR = 'user:okafor'
const PRIYA = 'user:priya'
const DANA = 'user:dana'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    { "key": "advisor", "targets": [{ "user": "user:okafor" }], "outcomes": ["approve"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
  { principal: PRIYA, scopes: ['instance.timeline'], resource: `flow:${SLUG}` },
  { principal: DANA, scopes: ['org.grants'], resource: 'org' },
]
const resolve: TargetResolver = (target) =>
  'starter' in target ? [SAM] : 'user' in target ? [target.user] : []

function deps(id: string, at = 1): OperationDeps {
  return { clock: () => at, ids: () => id }
}

function held(actor: string): readonly Grant[] {
  return grants.filter((grant) => grant.principal === actor)
}

/** The log: the flow pushed and published, Dana's grant, Sam's draft, a submitted instance. */
function build(): State {
  let state: State = emptyState
  const pushed = push(createFlow(SLUG), definition, deps('push'), DANA)
  const published = publish(pushed.flow, deps('publish'), DANA)
  state = apply(published.operation, apply(pushed.operation, state))
  state = apply(addGrant(grants[1], DANA, deps('grant')), state)
  const flow = { slug: SLUG, versions: published.flow.versions }
  const draft = startInstance(flow, 'draft-1', {}, SAM, deps('op-1'), resolve, held(SAM))
  state = apply(draft.operation, state)
  const other = startInstance(flow, 'sent-1', {}, SAM, deps('op-2', 2), resolve, held(SAM))
  state = apply(other.operation, state)
  const sent = submitInstance(
    other.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants: held(SAM) },
    deps('op-3', 3)
  )
  if (sent.operation === undefined) throw new Error(sent.reason)
  return apply(sent.operation, state)
}

test('#256 I8 the log read shows each principal only what it may read', async () => {
  const { readableLog } = await import('../engine/logRead.js')
  const state = build()
  const all = state.log.map((event) => event.seq)
  const types = (events: readonly { seq: number }[]) =>
    events.map((event) => state.log[event.seq - 1].type)

  // Dana holds org.grants: the whole log, in order (I4).
  expect(readableLog(state.log, DANA, { grants: held(DANA), resolve }).map((e) => e.seq)).toEqual(
    all
  )

  // Sam reads his draft and his submitted instance, and no configuration.
  expect(types(readableLog(state.log, SAM, { grants: held(SAM), resolve }))).toEqual([
    'instance.started@1',
    'instance.started@1',
    'instance.submitted@1',
  ])

  // Okafor is the advisor of the submitted instance only: the draft is private.
  expect(
    readableLog(state.log, OKAFOR, { grants: held(OKAFOR), resolve }).map((e) => e.seq)
  ).toEqual([5, 6])

  // Priya holds instance.timeline: the flow's configuration changes, and no
  // instance she may not read.
  expect(types(readableLog(state.log, PRIYA, { grants: held(PRIYA), resolve }))).toEqual([
    'config.definition.changed@1',
    'config.definition.published@1',
    'config.grant.changed@1',
  ])

  // The instance filter and the limit serve the CLI (S16).
  const filtered = readableLog(state.log, OKAFOR, {
    grants: held(OKAFOR),
    resolve,
    instanceId: 'sent-1',
  })
  expect(filtered.map((e) => e.seq)).toEqual([5, 6])
  expect(
    readableLog(state.log, OKAFOR, { grants: held(OKAFOR), resolve, instanceId: 'draft-1' })
  ).toEqual([])
  expect(
    readableLog(state.log, DANA, { grants: held(DANA), resolve, limit: 2 }).map((e) => e.seq)
  ).toEqual([5, 6])
})
