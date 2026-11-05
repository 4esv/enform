import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S09, VT-3, S16, I8: the interface path of claim and approve in
// gui mode. Lee opens the registrar task, reads the status line, claims it,
// takes the claim back from the notification's Undo, claims again and
// approves; the notification offers Undo on the approval too. Expected to
// fail until the status line, the notification and the timeline undo exist.

test(
  '#269 the S09 gui path claims, undoes from the notification, claims again and approves',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
