import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S15, VT-5, DF-6, I4, I14: the interface path of an
// investigation in gui mode. Dana toggles the flow's changes into the
// instance timeline and reads them in one order with their author and a
// link to the difference; then Dr. Okafor claims and approves.

test(
  '#269 the S15 gui path shows the configuration changes in the timeline, in order, with a link to the difference',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
