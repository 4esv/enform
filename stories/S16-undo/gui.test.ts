import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S16, WF-5, A2, D6, I4: the interface path of the undo in gui
// mode. Undo stays available in the timeline for the approval Lee made by
// mistake; he undoes it with a reason, the timeline marks the approval as
// undone and the email that already went out as "Already sent", he approves
// the right request, and Priya records the decision at the final step, after
// which nothing offers Undo. Expected to fail until the timeline undo exists.

test.fails(
  '#269 the S16 gui path undoes from the timeline, marks the sent email, and nothing is undoable past the final step',
  () => proveGuiPath(guiGolden, guiSeed()),
  120_000
)
