import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S14, VT-1, VT-2, VT-3, VT-4, WF-5, I8: the interface path of
// finding the status in gui mode. Ana claims and releases, Jordan claims and
// sends back, and Sam reads the status line and the tracker of his own
// request: the difference between waiting to be opened and opened, the
// skipped step, and no note of the people who act on it. Expected to fail
// until the status line, the release control and the note count exist.

test(
  '#269 the S14 gui path claims, releases, sends back, and shows the starter the status and the tracker',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
