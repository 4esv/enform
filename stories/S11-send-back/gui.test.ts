import { test } from 'vitest'
import { proveGuiPath } from '../gui-proof.js'
import { guiGolden, guiSeed } from './scenario.js'

// Issue #269, S11, WF-3, AC-4, VT-3: the interface path of the send back in
// gui mode. Dr. Okafor writes the note and sends the request back; Sam sees
// the note above the form, corrects the summary and submits again; Dr. Okafor
// approves; Jordan, who may only send back, sends it back with a note.
// Expected to fail until the note and the controls exist as the path names them.

test.fails(
  '#269 the S11 gui path sends back with a note, resubmits, approves and sends back again',
  () => proveGuiPath(guiGolden, guiSeed()),
  180_000
)
