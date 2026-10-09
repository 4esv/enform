import type { Grant } from '../../engine/authorize.js'
import { GRANT_CHANGE_TYPE } from '../../engine/grants.js'
import { type Step, scenario } from '../../tools/harness/scenario.js'

// S02: Dana grants access by scope (STORIES.md). Every grant is one
// attributed `config.grant.changed@1` operation (AC-2, I14), and the engine
// derives the grant set from the log (I4). The path is deterministic (I6): it
// reads no clock and no random source.

/** The flow of the story (STORIES.md, the example flow). */
const FLOW = 'flow:course-overload'

/** The registrar step; Jordan may only send back at it (S02, AC-4). */
const REGISTRAR = 'flow:course-overload/step:registrar'

/** The chair step; the CS-Chairs group approves and sends back at it (S02, AC-4). */
const CHAIR = 'flow:course-overload/step:chair'

/** The grants that Dana adds in the golden path, in the order of the story (S02). */
export const grants: readonly Grant[] = [
  { principal: 'group:All-Students', scopes: ['instance.start'], resource: FLOW },
  {
    principal: 'user:lee',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: REGISTRAR,
  },
  {
    principal: 'user:ana',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: REGISTRAR,
  },
  {
    principal: 'group:CS-Chairs',
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: CHAIR,
  },
  { principal: 'user:jordan', scopes: ['step.outcome:send_back'], resource: REGISTRAR },
  {
    principal: 'user:priya',
    scopes: ['flow.edit', 'flow.dryrun', 'instance.read', 'instance.timeline', 'task.reassign'],
    resource: FLOW,
  },
]

/** One grant step: Dana records the grant as an attributed operation (I14). */
function grantStep(grant: Grant): Step {
  return { actor: 'dana', type: GRANT_CHANGE_TYPE, payload: grant }
}

/** The golden path: Dana adds the S02 grants to `course-overload` (S02, AC-2). */
export const golden = scenario({ slug: 'grant-scopes', steps: grants.map(grantStep) })
