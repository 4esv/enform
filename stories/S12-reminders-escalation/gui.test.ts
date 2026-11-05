import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S12, VT-2, SE-3, SE-4: the interface path of reminders and
// escalation in gui mode. The live tracker shows the due date, the
// reminders the worker sent and the escalation, then Dr. Okafor approves.

test(
  '#269 the S12 gui path shows the due date, the reminders and the escalation on the tracker, then approves',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
