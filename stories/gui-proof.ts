import { expect } from 'vitest'
import type { State } from '../engine/apply.js'
import { outboxOf } from '../engine/outbox.js'
import { runSteps } from '../tools/harness/runner.js'
import { goldenViewPrefix, guiCoverage, type Scenario, toView } from '../tools/harness/scenario.js'

// Issue #269, STORIES.md Golden path and Interface path: the proof that an
// interface path of a story maps to its engine steps. gui mode runs the
// scenario's declared gui prefix in Chromium against the seeded harness
// server, api mode posts the same intents through the API, and the two runs
// must agree event by event and side effect by side effect (I4, I6). The
// stories that act on a request (S09 to S16) share this proof.

/** Run a story's interface path in a browser and compare it with the api run on the same seed. */
export async function proveGuiPath(golden: Scenario, seed: State): Promise<void> {
  const declared = guiCoverage(golden.gui ?? [])
  expect(declared, 'the gui path declares a non-empty prefix').toBeGreaterThan(0)
  expect(declared, 'the gui path covers at most the scenario steps').toBeLessThanOrEqual(
    golden.steps.length
  )

  const api = await runSteps(golden, { mode: 'api', seed })
  const gui = await runSteps(golden, { mode: 'gui', seed })

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
}
