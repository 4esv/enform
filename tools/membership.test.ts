import { expect, test } from 'vitest'
import { claim } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import { parse } from '../engine/definition.js'
import { createInstance, type Instance } from '../engine/instance.js'
import { deprovision, syncMembership, USER_DEPROVISIONED } from '../engine/membership.js'
import type { OperationDeps } from '../engine/operation.js'
import { type Membership, refreshAssignees } from '../engine/resolve.js'

// Issue #73, ID-5, ID-4, A1, A8, AS-4, I4, I6, I14: group membership
// synchronizes with the directory, and a deprovisioned user's claimed tasks
// go back to the pool. The synchronization triggers, sign-in (ID-1) and a
// schedule, are not part of this engine: the synchronization is a pure
// function of an injected directory (I6), so the same directory always gives
// the same membership. AS-4 reads that membership on every resolution, so a
// member who joined is included with no new publication. A deprovisioned user
// is released: the task that they held returns to the pool (A1), and the
// append-only log records the change, attributed and versioned (I4, I14).
//
// The check is marked as expected to fail until the membership synchronization
// lands (#73, ID-5).

/** The time of the operations (I6): the clock is injected. */
const AT = 1_700_000_000_000

/** The injected sources of the path (I6): a fixed clock and sequential IDs. */
function sources(): OperationDeps {
  let next = 0
  return {
    clock: () => AT,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

/** The one step of the flow (WF-1): the registrar team holds it (AS-1, AS-4). */
const definition = parse(`{
  "schemaVersion": 1,
  "steps": [
    {
      "key": "registrar",
      "targets": [{ "team": "registrar-office" }]
    }
  ]
}
`)

/** The principal that starts the request (S06). */
const STARTER = 'user:sam'

/** The team that holds the registrar task, and the registrar staff (AS-1). */
const REGISTRAR_TEAM = 'registrar-office'
const LEE = 'user:lee'
const ANA = 'user:ana'

/**
 * The injected directory before the synchronization (ID-4, ID-5): Lee holds
 * the registrar team, and Ana is a provisioned user outside it. A provisioned
 * user resolves to itself, so the directory still holds Lee.
 */
const before: Membership = (principal) => {
  if (principal === REGISTRAR_TEAM) return [LEE]
  if (principal === LEE || principal === ANA) return [principal]
  return []
}

/**
 * The directory after the synchronization (ID-5): Lee left the directory, and
 * Ana joined the registrar team. The directory no longer holds Lee, so the
 * deprovision of Lee has to release the task that he claimed.
 */
const directory: Membership = (principal) => {
  if (principal === REGISTRAR_TEAM) return [ANA]
  if (principal === ANA) return [ANA]
  return []
}

/** The registrar team snapshot that the instance recorded when Lee claimed it (I13). */
const assignees = [{ step: 'registrar', target: { team: REGISTRAR_TEAM }, members: [LEE] }] as const

/** The draft that Lee claims: a registrar task that routes to the registrar team (S06, I13). */
const draft: Instance = {
  ...createInstance(definition, assignees),
  currentStep: 'registrar',
  submitted: false,
  starter: STARTER,
}

test.fails('#73 ID-5 group membership synchronizes and a deprovision releases claimed tasks', () => {
  // (a) The synchronization makes the enform membership equal to the directory
  // (ID-5): Ana, who joined, is present, and Lee, who left, is absent. The
  // membership is a pure function of the directory (I6), so two syncs agree.
  const synced = syncMembership(directory, before)
  expect(synced(REGISTRAR_TEAM)).toEqual([ANA])
  expect(synced(REGISTRAR_TEAM)).toContain(ANA)
  expect(synced(REGISTRAR_TEAM)).not.toContain(LEE)
  expect(synced(LEE)).toEqual([])
  expect(syncMembership(directory, before)(REGISTRAR_TEAM)).toEqual([ANA])

  // Lee claims the registrar task, and the log records the claim (S09, I14).
  // One shared source, so every recorded operation gets a distinct ID (I1).
  const deps = sources()
  let state: State = emptyState
  const claimed = claim(draft, LEE, 0, deps)
  expect(claimed.accepted).toBe(true)
  expect(claimed.instance.holder).toBe(LEE)
  if (claimed.operation === undefined) throw new Error(`the claim was refused: ${claimed.reason}`)
  state = apply(claimed.operation, state)

  // The task is read at the log position that the claim produced (I5).
  const held: Instance = { ...claimed.instance, version: state.log.length }

  // (b) A deprovision of a principal that the directory still holds is refused
  // (ID-5): Lee is a current member before the sync, so nothing is released.
  const refused = deprovision(LEE, before, [held], deps)
  expect(refused.accepted).toBe(false)
  expect(refused.operation).toBeUndefined()
  expect(refused.instances).toEqual([held])
  expect(refused.reason).toContain('still a current member')

  // (c) Deprovisioning Lee releases his claimed task: the holder clears, so
  // the task returns to the pool (ID-5, A1). The engine records one attributed
  // event on the append-only log (I4, I14), and two runs agree (I6).
  const released = deprovision(LEE, synced, [held], deps)
  expect(released.accepted).toBe(true)
  expect(released.instances).toHaveLength(1)
  expect(released.instances[0].holder).toBeUndefined()
  if (released.operation === undefined) {
    throw new Error(`the deprovision was refused: ${released.reason}`)
  }
  // I6: the same inputs and the same injected sources give the same result.
  expect(deprovision(LEE, synced, [held], sources())).toEqual(
    deprovision(LEE, synced, [held], sources())
  )
  state = apply(released.operation, state)

  const events = state.log.filter((event) => event.type === USER_DEPROVISIONED)
  expect(events).toHaveLength(1)
  expect(events[0].actor).toBe(LEE)
  expect(events[0].payload.principal).toBe(LEE)
  expect(events[0].payload.released).toEqual(['registrar'])
  // The claim stays on the log: the deprovision appends and never rewrites (I4).
  expect(state.log).toHaveLength(2)

  // (d) The released task returns to a pool that the synchronization refreshed
  // (AS-4, ID-5): the registrar team holds Ana now, so she claims the task.
  const pooled = refreshAssignees(released.instances[0].assignees, synced)
  expect(pooled).toEqual([{ step: 'registrar', target: { team: REGISTRAR_TEAM }, members: [ANA] }])
  const reopened: Instance = {
    ...released.instances[0],
    assignees: pooled,
    version: state.log.length,
  }
  const byAna = claim(reopened, ANA, reopened.version ?? 0, sources())
  expect(byAna.accepted).toBe(true)
  expect(byAna.instance.holder).toBe(ANA)
})
