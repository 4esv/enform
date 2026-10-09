import { expect, test } from 'vitest'
import { claim, STEP_CLAIMED } from '../../engine/action.js'
import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Instance } from '../../engine/instance.js'
import type { OperationDeps } from '../../engine/operation.js'
import { outboxOf } from '../../engine/outbox.js'
import { startInstance } from '../../engine/submission.js'
import { STEP_TAKEN_OVER, type TakeoverResult, takeover } from '../../engine/takeover.js'
import {
  ANA,
  data,
  flow,
  LEE,
  REGISTRAR_MEMBERS,
  REGISTRAR_STEP,
  REGISTRAR_TEAM,
  resolve,
  STARTER,
  starterGrants,
} from './scenario.js'

/** The time of Lee's claim (I6): the idle period counts from this event. */
const CLAIM_AT = 1_700_000_000_000

/** Ten minutes: Lee was active this long ago, below the four-hour idle period (AS-3). */
const TEN_MINUTES = 10 * 60 * 1000

/** Four hours: the idle period that the step allows before a takeover (AS-3). */
const FOUR_HOURS = 4 * 60 * 60 * 1000

/** Two days: Lee is on vacation, above the four-hour idle period (AS-3). */
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000

/** The reason that Ana gives for the takeover (AS-3, I14). */
const REASON = 'Lee is out until 10/19'

/** The injected sources of the path (I6): the clock is a settable time and the IDs are `op-N`. */
function sources(clock: () => number): OperationDeps {
  let next = 0
  return {
    clock,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

/** Apply the operation that an accepted action returned (I14); the test checks acceptance first. */
function applyAction(result: TakeoverResult, state: State): State {
  if (result.operation === undefined) throw new Error(`the action was refused: ${result.reason}`)
  return apply(result.operation, state)
}

// Issue #47: Lee claimed the registrar task and went on vacation. Ana, an
// assignee of the step, takes it over after the idle period, and the engine
// records who took it, from whom, when and why and notifies Lee (AS-3, WF-5,
// I14, I2). Below the idle period the engine refuses with the remaining time
// (AS-3). A takeover from a stale view is refused at once (I5). The path is
// deterministic (I6).

test('#47 a peer takes over a claimed task after the idle period, with a reason (S10)', () => {
  // One shared source, so every recorded operation gets a distinct ID (I1).
  let now = CLAIM_AT
  const deps = sources(() => now)

  // The start routes the request to the registrar step, whose team target
  // resolves to Lee, Ana and Jordan (S06, I10, I13).
  const started = startInstance(flow, data, STARTER, deps, resolve, starterGrants)
  const state = apply(started.operation, emptyState)
  expect(started.instance.currentStep).toBe(REGISTRAR_STEP)
  expect(started.instance.assignees).toEqual([
    { step: REGISTRAR_STEP, target: { team: REGISTRAR_TEAM }, members: REGISTRAR_MEMBERS },
  ])

  // Lee claims the task at the claim time (S09, AS-2): the instance records
  // the holder, and the log records the claim with the time that the idle
  // period counts from.
  const opened = state.log.length
  const view: Instance = { ...started.instance, version: opened }
  const lee = claim(view, LEE, opened, deps)
  expect(lee.accepted).toBe(true)
  expect(lee.instance.holder).toBe(LEE)
  const held = lee.instance.version ?? 0
  const afterClaim = applyAction(lee, state)
  const claimEvent = afterClaim.log.find((event) => event.type === STEP_CLAIMED)
  expect(claimEvent?.at).toBe(CLAIM_AT)
  expect(claimEvent?.payload.holder).toBe(LEE)

  // (a) AS-3, WF-5: Lee has been idle for two days, above the four-hour idle
  // period, so Ana's takeover succeeds. The engine reassigns the holder and
  // records who took it, from whom, when and why (I14).
  now = CLAIM_AT + TWO_DAYS
  const taken = takeover(lee.instance, ANA, REASON, now, FOUR_HOURS, held, afterClaim.log, deps)
  expect(taken.accepted).toBe(true)
  expect(taken.instance.holder).toBe(ANA)
  expect(taken.operation?.type).toBe(STEP_TAKEN_OVER)
  expect(taken.operation?.actor).toBe(ANA)
  expect(taken.operation?.payload).toEqual({
    step: REGISTRAR_STEP,
    from: LEE,
    to: ANA,
    when: now,
    why: REASON,
    outbox: [taken.outbox],
  })

  // The previous holder is notified in the same commit (I2, SE-2): the
  // notification rides in the operation, and the outbox is its projection.
  expect(taken.outbox).toEqual({
    operation: 'send-takeover',
    target: 'connector-smtp',
    payload: { to: LEE, step: REGISTRAR_STEP, actor: ANA, reason: REASON },
  })
  const afterTakeover = applyAction(taken, afterClaim)
  expect(outboxOf(afterTakeover.log)).toEqual([taken.outbox])

  // The timeline records the takeover (I14): one attributed event, with the
  // reassign from Lee to Ana.
  const recorded = afterTakeover.log.filter((event) => event.type === STEP_TAKEN_OVER)
  expect(recorded).toHaveLength(1)
  expect(recorded[0].actor).toBe(ANA)
  expect(recorded[0].payload.from).toBe(LEE)
  expect(recorded[0].payload.to).toBe(ANA)

  // (b) AS-3: Lee was active ten minutes ago, below the four-hour idle period,
  // so the engine refuses Ana's takeover and shows the remaining time.
  now = CLAIM_AT + TEN_MINUTES
  const tooSoon = takeover(lee.instance, ANA, REASON, now, FOUR_HOURS, held, afterClaim.log, deps)
  expect(tooSoon.accepted).toBe(false)
  expect(tooSoon.operation).toBeUndefined()
  expect(tooSoon.outbox).toBeUndefined()
  expect(tooSoon.instance).toBe(lee.instance)
  expect(tooSoon.reason).toContain(String(FOUR_HOURS - TEN_MINUTES))

  // (c) I5: a takeover based on the stale view, the version before the claim,
  // is refused at once, so the reassign happens once and the log keeps one
  // takeover.
  const stale = takeover(lee.instance, ANA, REASON, now, FOUR_HOURS, opened, afterClaim.log, deps)
  expect(stale.accepted).toBe(false)
  expect(stale.operation).toBeUndefined()
  expect(stale.instance).toBe(lee.instance)
  expect(stale.reason).toContain('stale')

  // AS-3: only an assignee of the step may take it over, and only a claimed
  // task has a holder to take over from.
  const outsider = takeover(
    lee.instance,
    'user:outsider',
    REASON,
    now,
    FOUR_HOURS,
    held,
    afterClaim.log,
    deps
  )
  expect(outsider.accepted).toBe(false)
  expect(outsider.reason).toContain('not an assignee')
  const unclaimed = takeover(view, ANA, REASON, now, FOUR_HOURS, opened, state.log, deps)
  expect(unclaimed.accepted).toBe(false)
  expect(unclaimed.reason).toContain('not claimed')
})
