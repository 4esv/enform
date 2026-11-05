import { expect, test } from 'vitest'
import { runSteps } from '../../tools/harness/runner.js'
import { goldenViewPrefix, guiCoverage, toView } from '../../tools/harness/scenario.js'
import { guiGolden as golden, guiSeed } from './scenario.js'

// Issue #44, #262, S07, RT-1, RT-3, RT-4, RT-5, I1, I15, I16: the interface
// path of S07 in Chromium. The page starts the draft on the first change,
// the connection drops, two edits stay on the device and show "Saved on
// this device", a refresh shows them at once, a third edit and the submit
// queue, and the connection returns: every queued operation reaches the
// server once, in order, and the tracker shows the advisor step waiting.

test('#44 the S07 gui path types offline, refreshes, submits when back online, and loses nothing (S07)', async () => {
  const declared = guiCoverage(golden.gui ?? [])
  expect(declared).toBe(golden.steps.length)
  const api = await runSteps(golden, { mode: 'api', seed: guiSeed() })
  const gui = await runSteps(golden, { mode: 'gui', seed: guiSeed() })
  expect(toView(gui.state), 'gui mode and api mode differ').toEqual(toView(api.state))
  expect(toView(gui.state), 'the gui run did not reach the golden end state').toEqual(
    goldenViewPrefix(golden, declared)
  )
  expect(gui.intents).toEqual(api.intents)
}, 120_000)
