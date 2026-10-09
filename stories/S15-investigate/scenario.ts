import { apply, emptyState, type State } from '../../engine/apply.js'
import type { Grant } from '../../engine/authorize.js'
import { configOperation } from '../../engine/config.js'
import { DEFINITION_CHANGED, type FlowDefinition, parse } from '../../engine/definition.js'
import { DEFINITION_PUBLISHED, type Flow } from '../../engine/flow.js'
import { addGrant, GRANT_CHANGE_TYPE } from '../../engine/grants.js'
import { type ConnectorCall, contentHash } from '../../engine/instance.js'
import {
  type ActorId,
  createOperation,
  type Log,
  type Operation,
  type OperationDeps,
} from '../../engine/operation.js'
import type { TargetResolver } from '../../engine/routing.js'
import { ASSIGNMENT_EMAIL, startInstance } from '../../engine/submission.js'
import { CONNECTOR_CALLED } from '../../engine/timeline.js'

// S15: investigate a problem (STORIES.md). Dana reads the timeline of the log
// (I4): the flow edit that she made and the instance event that Sam caused,
// in one global order (VT-5). The change feed filters by flow and by type
// (VT-6), and a connector call shows its operation, its time and its outcome
// and no response body (I13). The path is deterministic (I6): the clock and
// the ID generator are injected, and it reads no random source.

/** The flow slug of the story (STORIES.md, the example flow). */
export const SLUG = 'course-overload'

/** The resource of the flow (MVP.md 5.6): a grant on it covers all of its steps. */
export const FLOW = `flow:${SLUG}`

/** Dana, the developer who maintains enform at the institution (STORIES.md, Cast). */
export const DANA: ActorId = 'user:dana'

/** Sam, the student who starts the request (S06, AC-5). */
export const SAM: ActorId = 'user:sam'

/** The worker, which records the connector calls that it runs (SE-1, I13). */
export const SYSTEM: ActorId = 'system'

/** The team that holds the registrar task (AS-1, AS-4). */
export const REGISTRAR_TEAM = 'registrar-office'

/** The time of the first event (I6): the clock is injected and the path reads no random source. */
export const NOW = 1_700_000_000_000

/** The one-minute step between the events, so the feed reads in time order (S15). */
export const STEP = 60_000

/** The two steps of the story: the request, then the registrar (WF-1). */
export const draft: FlowDefinition = parse(`{
  "schemaVersion": 1,
  "steps": [
    { "key": "request", "targets": [{ "starter": "starter" }], "outcomes": ["submit"] },
    { "key": "registrar", "targets": [{ "team": "${REGISTRAR_TEAM}" }], "outcomes": ["approve", "reject"] }
  ]
}
`)

/** The event type of one definition change, for the type filter (VT-6, I14). */
export const EDIT_TYPE = DEFINITION_CHANGED

/** The event type of a publication, for the type filter (VT-6, DF-2). */
export const PUBLISHED_TYPE = DEFINITION_PUBLISHED

/** The event type of one grant change, for the type filter (VT-6, AC-2). */
export const GRANT_TYPE = GRANT_CHANGE_TYPE

/** The publication of version 1: the slug, the version, the hash and the frozen definition (DF-2). */
export const publication = {
  slug: SLUG,
  version: 1,
  contentHash: contentHash(draft),
  definition: draft,
}

/** Dana's grant change: the All-Students group may start the flow (S02, AC-2). */
export const grant: Grant = {
  principal: 'group:All-Students',
  scopes: ['instance.start'],
  resource: FLOW,
}

/** The published version 1: a start needs a version with a content hash (DF-2). */
export const flow: Flow = {
  slug: SLUG,
  versions: [{ version: 1, contentHash: contentHash(draft), definition: draft }],
}

/** The directory of the story (AS-1, I13): the team and the starter resolve. */
export const resolve: TargetResolver = (target) =>
  'team' in target ? ['user:lee', 'user:ana'] : [SAM]

/** The grants that apply to Sam: the All-Students group may start the flow (S02, AC-1). */
export const starterGrants: readonly Grant[] = [grant]

/** One connector call: the assignment email that the worker ran (I13). */
export const call: ConnectorCall = {
  operation: ASSIGNMENT_EMAIL,
  time: NOW + 6 * STEP,
  outcome: 'sent',
}

/**
 * The injected sources of the story (I6): the clock advances one minute per
 * operation, and the IDs are `op-N`. One shared source gives every operation a
 * distinct ID and a distinct time, in the order of the story.
 */
function deps(): OperationDeps {
  let time = 0
  let id = 0
  return {
    clock: () => {
      const at = NOW + time * STEP
      time += 1
      return at
    },
    ids: () => {
      id += 1
      return `op-${id}`
    },
  }
}

/**
 * The log of the story (I4): the changes to the flow, the configuration and
 * the instance, in one global order. Dana makes the configuration changes, Sam
 * causes the instance event, and the worker records the connector call. The
 * timeline projects this log; it reads no other store (VT-5).
 */
export function investigationLog(): Log {
  const sources = deps()
  const operations: readonly Operation[] = [
    configOperation({ kind: 'definition', actor: DANA, payload: draft }, sources),
    createOperation(DEFINITION_PUBLISHED, publication, sources, DANA),
    addGrant(grant, DANA, sources),
    configOperation(
      {
        kind: 'team',
        actor: DANA,
        payload: { name: REGISTRAR_TEAM, members: ['user:lee', 'user:ana'] },
      },
      sources
    ),
    configOperation(
      {
        kind: 'connector',
        actor: DANA,
        payload: { name: 'connector-smtp', operations: [ASSIGNMENT_EMAIL] },
      },
      sources
    ),
    configOperation(
      { kind: 'template', actor: DANA, payload: { name: 'assignment-email' } },
      sources
    ),
    startInstance(flow, {}, SAM, sources, resolve, starterGrants).operation,
    createOperation(CONNECTOR_CALLED, { ...call }, sources, SYSTEM),
  ]
  return operations.reduce((state: State, operation) => apply(operation, state), emptyState).log
}
