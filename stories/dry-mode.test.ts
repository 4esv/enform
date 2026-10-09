import { expect, test } from 'vitest'
import { outboxOf } from '../engine/outbox.js'
import { runSteps } from '../tools/harness/runner.js'
import { goldenView, scenario, toView } from '../tools/harness/scenario.js'
import { golden } from './S01-publish-flow/scenario.js'

// Issue #26, STORIES.md Golden path: the dry mode runs the same steps as a dry
// run, and the side-effect intents must equal those of api mode (I7). The
// check compares the two modes over one scenario, so it fails when either mode
// drops a side effect. The scenario must carry a side effect, or the parity
// check holds vacuously.
//
// This file sits at the root of stories/ on purpose. The story-mode matrix
// reads every `.test.ts` of a story suite, so a dry-mode file inside
// S01-publish-flow would flip S01's matrix cell. Issue #26 extends the harness
// runner, not S01's acceptance, so the check stays out of that suite.

// The S01 publish-flow scenario causes no side effect, so draft the same flow
// with one: the publish sends a confirmation email (SE-1, SE-2).
const publishing = scenario({
  slug: 'publish-flow-with-side-effect',
  steps: [
    ...golden.steps,
    {
      actor: 'dana',
      type: 'flow.published@1',
      payload: { slug: 'course-overload' },
      outbox: [
        {
          operation: 'send-flow-published',
          target: 'connector-smtp',
          payload: { to: 'person-dana', slug: 'course-overload' },
        },
      ],
    },
  ],
})

test.fails('#26 the dry run gives the same side-effect intents as api mode (I7)', async () => {
  const declared = publishing.steps.flatMap((step) => step.outbox ?? [])
  expect(declared.length, 'the scenario declares no side effect to compare').toBeGreaterThan(0)
  const api = await runSteps(publishing, { mode: 'api' })
  const dry = await runSteps(publishing, { mode: 'dry' })
  expect(outboxOf(api.state.log), 'api mode did not commit the side effect').toEqual(declared)
  expect(dry.intents, 'the dry run and the api outbox differ (I7)').toEqual(outboxOf(api.state.log))
  expect(toView(api.state), 'api mode did not reach the golden end state').toEqual(
    goldenView(publishing)
  )
  expect(dry.state.log, 'the dry run wrote an event').toEqual([])
})
