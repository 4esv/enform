import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S10, AS-3, WF-5, VT-3: the interface path of the takeover in
// gui mode. The task shows who holds it, Ana takes it over with a reason, and
// Lee undoes the takeover from the timeline with a reason; the timeline then
// marks the takeover as undone. Expected to fail until the status line and
// the timeline undo exist.

test.fails(
  '#269 the S10 gui path takes the task over and the previous holder undoes it from the timeline',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
