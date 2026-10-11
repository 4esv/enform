import { expect, test } from 'vitest'
import { outboxOf } from '../../engine/outbox.js'
import { runSteps } from '../../tools/harness/runner.js'
import { goldenViewPrefix, toView } from '../../tools/harness/scenario.js'
import { flowState, golden, resolve, samGrants } from './scenario.js'

// Issue #27, STORIES.md Golden path and Interface path: gui mode runs a
// scenario's steps in a browser, and each covered GUI step maps to the engine
// step at the same index. The interface path of S06 covers the start step
// only: Sam opens the form link, fills the request form and submits it, which
// appends instance.started@1. The submit step is uncovered today, because a
// submit intent needs an instance identity that instance.started@1 does not
// carry, so the scenario's gui path declares the start prefix and this check
// compares that prefix to api mode's.
//
// The runner injects the same step clock and ID source that stepOperation
// uses, so the browser's intent carries `op-1` and `at = 1` exactly, and the
// resolved event equals the engine's start (I6).

test.fails('#27 the S06 gui path maps its declared prefix to the engine steps', async () => {
  const declared = golden.gui?.length ?? 0
  expect(declared, 'the gui path declares a non-empty prefix').toBeGreaterThan(0)
  expect(declared, 'the gui path covers only the prefix the interface path declares').toBeLessThan(
    golden.steps.length
  )

  const api = await runSteps(golden, { mode: 'api' })
  const gui = await runSteps(golden, {
    mode: 'gui',
    resolve,
    grants: samGrants,
    seed: flowState(),
  })

  // The gui run equals the api run for the declared prefix: the same applied
  // IDs and the same events, event by event (I4, I6).
  const apiView = toView(api.state)
  const apiPrefix = {
    applied: apiView.applied.slice(0, declared),
    log: apiView.log.slice(0, declared),
  }
  expect(toView(gui.state), 'gui mode and api mode differ on the declared prefix').toEqual(
    apiPrefix
  )
  expect(toView(gui.state), 'the gui run did not reach the golden prefix').toEqual(
    goldenViewPrefix(golden, declared)
  )
  expect(gui.intents, 'the gui prefix and api prefix differ in side effects').toEqual(
    outboxOf(apiPrefix.log)
  )
}, 30_000)
