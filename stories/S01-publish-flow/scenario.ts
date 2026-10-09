import { scenario } from '../../tools/harness/scenario.js'

// S01: Dana creates and publishes a flow (STORIES.md). The flow is a
// definition (I14); publishing it appends one config.definition.changed@1
// operation attributed to Dana. The full story (validation, dry run, grants)
// arrives with its own milestone work; this is the golden path the runner
// exercises.

export const golden = scenario({
  slug: 'publish-flow',
  steps: [
    {
      actor: 'dana',
      type: 'config.definition.changed@1',
      payload: { slug: 'course-overload', title: 'Course overload' },
    },
  ],
})
