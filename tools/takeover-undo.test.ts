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
import { takeover } from '../engine/takeover.js'
import { undoAction } from '../engine/undo.js'

// Issue #47, S10, AS-3, WF-5, A2, I8: a takeover moves a task from a peer, so
// the holder may not take over from himself; and the person a takeover took
// the task from may undo it, like its actor and a flow owner, so Lee keeps
// his task without an administrator when he comes back early.

const SLUG = 'course-overload'
const SAM = 'user:sam'
const LEE = 'user:lee'
const ANA = 'user:ana'
const JORDAN = 'user:jordan'

const definition = parse(`{
  "schemaVersion": 2,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }] },
    {
      "key": "registrar",
      "targets": [{ "team": "registrar-office" }],
      "outcomes": ["approve"],
      "takeover": "after-idle",
      "idleMinutes": 240
    }
  ]
}
`)

const grants: readonly Grant[] = [
  { principal: SAM, scopes: ['instance.start'], resource: `flow:${SLUG}` },
]

const resolve: TargetResolver = (target) => {
  if ('starter' in target) return [SAM]
  if ('team' in target) return [LEE, ANA, JORDAN]
  return []
}

const HOUR = 3_600_000
const T0 = 1_700_000_000_000
const IDLE = 4 * HOUR

function deps(id: string, at: number): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/** The log with Lee holding the registrar task since T0 + 2. */
function claimedState(): State {
  const pushed = push(createFlow(SLUG), definition, deps('push', T0), 'user:dana')
  const released = publish(pushed.flow, deps('publish', T0), 'user:dana')
  let state = apply(released.operation, apply(pushed.operation, emptyState))
  const started = startInstance(
    { slug: SLUG, versions: released.flow.versions },
    'inst-1',
    {},
    SAM,
    deps('op-1', T0),
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
    deps('op-2', T0 + 1)
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  state = apply(submitted.operation, state)
  const claimed = claim(submitted.instance, LEE, 1, deps('op-3', T0 + 2))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  return apply(claimed.operation, state)
}

function current(state: State) {
  const instance = instanceOf(state.log, 'inst-1')
  if (instance === undefined) throw new Error('not projected')
  return instance
}

test('#47 a holder may not take over from himself, and the previous holder may undo a takeover', () => {
  let state = claimedState()
  const later = T0 + 2 + 2 * 24 * HOUR

  // Lee holds the task: a takeover by Lee changes nothing and is refused (AS-3).
  const self = takeover(
    current(state),
    LEE,
    'back early',
    later,
    IDLE,
    2,
    state.log,
    deps('op-4', later)
  )
  expect(self.accepted).toBe(false)
  expect(self.reason).toContain('already holds')

  // Ana takes over after two idle days (AS-3), then Lee undoes it (WF-5, S10).
  const taken = takeover(
    current(state),
    ANA,
    'Lee is out',
    later,
    IDLE,
    2,
    state.log,
    deps('op-4', later)
  )
  if (taken.operation === undefined) throw new Error(taken.reason)
  state = apply(taken.operation, state)
  const takeoverSeq = state.log[state.log.length - 1].seq
  const context = {
    flow: SLUG,
    definition,
    log: state.log,
    grants: [],
    now: later + HOUR,
    undoPeriod: 24 * HOUR,
  }
  const byLee = undoAction(
    current(state),
    LEE,
    takeoverSeq,
    'I am back',
    3,
    context,
    deps('op-5', later + HOUR)
  )
  expect(byLee.accepted).toBe(true)

  // Jordan neither took the task nor lost it: refused, and the reason names
  // Ana and Lee (I8).
  const byJordan = undoAction(
    current(state),
    JORDAN,
    takeoverSeq,
    'no',
    3,
    context,
    deps('op-5', later + HOUR)
  )
  expect(byJordan.accepted).toBe(false)
  expect(byJordan.status).toBe(403)
  expect(byJordan.reason).toContain(LEE)
})
