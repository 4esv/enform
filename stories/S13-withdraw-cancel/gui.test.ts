import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S13, WF-4, WF-5, VT-3: the interface path of withdraw and
// cancel in gui mode. Sam withdraws his own request with a reason and the
// status line says so; he undoes it and the task is back with Ana. Priya
// cancels with a reason and undoes that too. Expected to fail until the
// status line names the close and its reason.

test(
  '#269 the S13 gui path withdraws and undoes, cancels and undoes, each with a reason',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
