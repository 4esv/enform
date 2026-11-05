import { expect, test } from 'vitest'
import { outboxOf } from '../../engine/outbox.js'
import { runSteps } from '../../tools/harness/runner.js'
import { goldenViewPrefix, guiCoverage, toView } from '../../tools/harness/scenario.js'
import { flowState, guiGolden as golden } from './scenario.js'

// Issue #27, STORIES.md Golden path and Interface path: gui mode runs a
// scenario's steps in a browser, and each covered GUI step maps to the engine
// step at the same index. The interface path of S06 covers the start step
// only: Sam opens the form link, fills the request form and submits it, which
// appends instance.started@1. The submit intent exists since #256 (ADR 0014),
// but the browser's submit of a draft has no gui step yet, so the scenario's
// gui path declares the start prefix and this check compares that prefix to
// api mode's. The browser posts the start intent against the seeded server,
// which resolves it through the engine; the resolved event must equal the
// declared step (ADR 0010).
//
// The runner injects the same step clock and ID sources that stepOperation
// uses, so the browser's intent carries `op-1`, the step's instance id and
// `at = 1` exactly, and the resolved event equals the engine's start (I6).

test('#27 the S06 gui path maps its declared prefix to the engine steps', async () => {
  const declared = guiCoverage(golden.gui ?? [])
  expect(declared, 'the gui path declares a non-empty prefix').toBeGreaterThan(0)
  expect(declared, 'the gui path covers at most the scenario steps').toBeLessThanOrEqual(
    golden.steps.length
  )

  const api = await runSteps(golden, { mode: 'api', seed: flowState() })
  const gui = await runSteps(golden, { mode: 'gui', seed: flowState() })

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
}, 90_000)
