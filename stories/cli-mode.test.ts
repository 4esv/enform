import { expect, test } from 'vitest'
import { runSteps } from '../tools/harness/runner.js'
import { goldenView, toView } from '../tools/harness/scenario.js'
import { golden } from './S01-publish-flow/scenario.js'

// Issue #25, STORIES.md Golden path: the cli mode runs a scenario's steps
// through the CLI with `--json`, and the result must equal the api mode
// result. The check compares the two modes over one scenario, event by event,
// so it fails when either mode drops or changes an event; the golden end state
// is the shared target (I6).
//
// This file sits at the root of stories/ on purpose. The story-mode matrix
// reads every `.test.ts` of a story suite, so a cli-mode file inside
// S01-publish-flow would flip S01's matrix cell. Issue #25 extends the harness
// runner, not S01's acceptance, so the check stays out of that suite.
//
// `test.fails` asserts that the check fails until the cli mode is
// implemented: the scaffold returns the empty state, so the two modes differ.
// The next commit implements the mode and removes the mark.

test.fails('#25 cli mode reaches the same end state as api mode (S01)', async () => {
  const api = await runSteps(golden, { mode: 'api' })
  const cli = await runSteps(golden, { mode: 'cli' })
  // Non-vacuous: the golden path has a step, so the log comparison has content.
  expect(goldenView(golden).log.length, 'the scenario has no step to compare').toBeGreaterThan(0)
  // The cli run equals the api run, applied IDs and events, not just exit codes.
  expect(toView(cli.state), 'cli mode and api mode differ').toEqual(toView(api.state))
  expect(toView(cli.state), 'the cli run did not reach the golden end state').toEqual(
    goldenView(golden)
  )
  expect(cli.intents, 'cli mode and api mode differ in side effects').toEqual(api.intents)
})
