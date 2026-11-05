import { expect, test } from 'vitest'
import { claim } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import { parse } from '../engine/definition.js'
import { createFlow, publish, push } from '../engine/flow.js'
import { instanceOf } from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #267, AS-4, I13, S08: a group or a team resolves live when a person
// views or claims the task. The instance records the members the team held at
// routing time (the snapshot, I13), and a read already refreshes the live
// targets through the directory. A claim must do the same: Ana, who joined
// registrar-office while the task was open, sees the task as available and
// claims it, with no new publication. A dynamic target keeps its snapshot.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const LEE = 'user:lee'
const ANA = 'user:ana'
const OKAFOR = 'user:okafor'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "request",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "advisor", "control": "user" }],
      "editable": ["advisor"]
    },
    { "key": "registrar", "targets": [{ "team": "registrar-office" }], "outcomes": ["approve"] },
    { "key": "advisor", "targets": [{ "field": "advisor" }], "outcomes": ["approve"] }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

/** The directory with the registrars it holds now (AS-4). */
function directory(registrars: readonly string[]): TargetResolver {
  return (target) => {
    if ('starter' in target) return [SAM]
    if ('team' in target) return registrars
    if ('field' in target) return [OKAFOR]
    return []
  }
}

function deps(id: string, at: number): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/** The log with the registrar task open, routed when the team held Lee alone. */
function routedState(): State {
  const pushed = push(createFlow(SLUG), definition, deps('push', 1), 'user:dana')
  const released = publish(pushed.flow, deps('publish', 2), 'user:dana')
  let state = apply(released.operation, apply(pushed.operation, emptyState))
  const resolve = directory([LEE])
  const started = startInstance(
    { slug: SLUG, versions: released.flow.versions },
    'inst-1',
    { advisor: OKAFOR },
    SAM,
    deps('op-1', 3),
    resolve,
    grants
  )
  state = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition, resolve, grants },
    deps('op-2', 4)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  return apply(submitted.operation, state)
}

test.fails('#267 AS-4 a claim resolves a team live: a member who joined after routing claims the task', () => {
  const state = routedState()
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('not projected')
  // The snapshot names Lee alone (I13).
  expect(instance.assignees).toContainEqual({
    step: 'registrar',
    target: { team: 'registrar-office' },
    members: [LEE],
  })

  // Without a directory the claim reads the snapshot: Ana is refused.
  const stale = claim(instance, ANA, instance.version ?? 0, deps('op-3', 5))
  expect(stale.accepted).toBe(false)
  expect(stale.reason).toContain('not an assignee')

  // Through the directory that holds Ana now, the claim is accepted and the
  // claim event names her as the holder (AS-4, I14).
  const live = claim(instance, ANA, instance.version ?? 0, deps('op-3', 5), directory([LEE, ANA]))
  expect(live.accepted).toBe(true)
  expect(live.instance.holder).toBe(ANA)
  expect(live.operation?.payload).toMatchObject({
    instanceId: 'inst-1',
    step: 'registrar',
    holder: ANA,
  })

  // A member who left is no longer an assignee, even though the snapshot names him.
  const left = claim(instance, LEE, instance.version ?? 0, deps('op-3', 5), directory([ANA]))
  expect(left.accepted).toBe(false)

  // A dynamic target keeps its snapshot (I13): the directory is not asked for the advisor.
  const asked: string[] = []
  const spy: TargetResolver = (target) => {
    asked.push(Object.keys(target)[0] ?? '')
    return directory([LEE, ANA])(target)
  }
  claim(instance, ANA, instance.version ?? 0, deps('op-3', 5), spy)
  expect(asked).toEqual(['team'])
})
