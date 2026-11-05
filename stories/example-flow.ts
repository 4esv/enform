import { claim, complete } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type Field, type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, type FlowVersion, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import { instanceOf, type ProjectedInstance } from '../engine/instances.js'
import type { ActorId, Operation, OperationDeps } from '../engine/operation.js'
import { outboxOf } from '../engine/outbox.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { addTeamMember, createTeam, TEAM_CHANGE_TYPE } from '../engine/teams.js'
import { resolverFor } from '../server/intents.js'
import type { Membership } from '../tools/harness/directory.js'
import type { Versioning } from '../tools/harness/operators.js'
import { type Step, stepOperation } from '../tools/harness/scenario.js'

// STORIES.md, Cast and Example flow: the one flow that every story shares,
// with the people and the grants of the cast (S02), so the stories share one
// fixture. The grants are the installation's before a story (the harness
// `bootstrap`), the groups are the directory's (the harness `membership`),
// and the registrar team is created in the log by the story's setup steps
// (AS-6), because a team is a configuration the log records. The fixture is
// deterministic (I6): it reads no clock and no random source.

/** The flow slug of the example flow (STORIES.md, Example flow). */
export const SLUG = 'course-overload'

/** The resource of the flow (MVP.md 5.6). */
export const FLOW = `flow:${SLUG}`

/** The resource of one step of the flow (MVP.md 5.6). */
export function stepResource(step: string): string {
  return `${FLOW}/step:${step}`
}

/** The cast (STORIES.md, Cast): people, not roles. */
export const DANA = 'user:dana'
export const PRIYA = 'user:priya'
export const SAM = 'user:sam'
export const OKAFOR = 'user:okafor'
export const LIN = 'user:lin'
export const LEE = 'user:lee'
export const ANA = 'user:ana'
export const JORDAN = 'user:jordan'

/** Everyone of the cast, in the order of STORIES.md, so a generated variant order is deterministic (I6). */
export const PEOPLE: readonly ActorId[] = [DANA, PRIYA, SAM, OKAFOR, LIN, LEE, ANA, JORDAN]

/** The team and the groups of the example flow (STORIES.md, Cast). */
export const REGISTRAR_TEAM = 'registrar-office'
export const CHAIRS_GROUP = 'CS-Chairs'
export const STUDENTS_GROUP = 'All-Students'

/** The steps of the example flow (STORIES.md, Example flow). */
export const REQUEST_STEP = 'request'
export const ADVISOR_STEP = 'advisor'
export const CHAIR_STEP = 'chair'
export const REGISTRAR_STEP = 'registrar'

/** The members of the registrar team once the setup steps ran (AS-4). */
export const REGISTRAR_MEMBERS: readonly ActorId[] = [LEE, ANA, JORDAN]

/**
 * The example flow, version 1 (STORIES.md, Example flow). Sam fills in the
 * request form: a summary, the overload credits and his advisor. The advisor
 * step targets the advisor field (AS-1), the chair step targets the CS-Chairs
 * group and is skipped when the overload is two credits or fewer (S05, WF-1),
 * and the registrar step targets the registrar team, with a takeover allowed
 * after four hours of idle time (S10, AS-3).
 */
export const definitionV1: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number", "required": true },
        { "key": "advisor", "control": "user", "required": true }
      ],
      "editable": ["summary", "overload_credits", "advisor"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "${CHAIR_STEP}",
      "targets": [{ "group": "${CHAIRS_GROUP}" }],
      "outcomes": ["approve", "send_back"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["approve", "reject"],
      "takeover": "after-idle",
      "idleMinutes": 240
    }
  ]
}
`)

/** Version 2 of the example flow: it adds an optional field to the request form (S04, DF-2). */
export const definitionV2: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST_STEP}",
      "targets": [{ "starter": "starter" }],
      "fields": [
        { "key": "summary", "control": "text", "required": true },
        { "key": "overload_credits", "control": "number", "required": true },
        { "key": "advisor", "control": "user", "required": true },
        { "key": "reason_category", "control": "text" }
      ],
      "editable": ["summary", "overload_credits", "advisor", "reason_category"]
    },
    {
      "key": "${ADVISOR_STEP}",
      "targets": [{ "field": "advisor" }],
      "outcomes": ["approve", "send_back"]
    },
    {
      "key": "${CHAIR_STEP}",
      "targets": [{ "group": "${CHAIRS_GROUP}" }],
      "outcomes": ["approve", "send_back"],
      "skipWhen": { "<=": [{ "var": "overload_credits" }, 2] }
    },
    {
      "key": "${REGISTRAR_STEP}",
      "targets": [{ "team": "${REGISTRAR_TEAM}" }],
      "outcomes": ["approve", "reject"],
      "takeover": "after-idle",
      "idleMinutes": 240
    }
  ]
}
`)

/** The published version 1 and the flow ready for a start (DF-2). */
export const versionV1: FlowVersion = {
  version: 1,
  contentHash: contentHash(definitionV1),
  definition: definitionV1,
}
export const flow: Flow = { slug: SLUG, versions: [versionV1] }

/** The form fields of the example flow, in step order (FM-1): the Data operator generates values for them. */
export const fields: readonly Field[] = definitionV1.steps.flatMap((step) => step.fields ?? [])

/** How the Version operator publishes version 2 between two steps (STORIES.md, Fuzzy paths). */
export const versioning: Versioning = {
  actor: DANA,
  slug: SLUG,
  definition: definitionV2,
  started: definitionV1,
}

/**
 * The grants of the cast (STORIES.md, Cast; S02): what the installation holds
 * before a story. Dana administers the organization and builds every flow.
 * Priya owns the overload flow. Sam starts it through the All-Students group.
 * Dr. Okafor decides the advisor step, the CS-Chairs group the chair step,
 * Lee and Ana the registrar step, and Jordan may only send back there.
 */
export const bootstrap: readonly Grant[] = [
  { principal: DANA, scopes: ['org.grants', 'org.teams', 'org.impersonate'], resource: 'org' },
  { principal: DANA, scopes: ['flow.build'], resource: '*' },
  {
    principal: PRIYA,
    scopes: ['flow.edit', 'flow.dryrun', 'instance.read', 'instance.timeline', 'task.reassign'],
    resource: FLOW,
  },
  { principal: `group:${STUDENTS_GROUP}`, scopes: ['instance.start'], resource: FLOW },
  {
    principal: OKAFOR,
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: stepResource(ADVISOR_STEP),
  },
  {
    principal: `group:${CHAIRS_GROUP}`,
    scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    resource: stepResource(CHAIR_STEP),
  },
  {
    principal: LEE,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: stepResource(REGISTRAR_STEP),
  },
  {
    principal: ANA,
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: stepResource(REGISTRAR_STEP),
  },
  { principal: JORDAN, scopes: ['step.outcome:send_back'], resource: stepResource(REGISTRAR_STEP) },
]

/** The groups of the cast (STORIES.md, Cast; ID-4): Sam is a student, Dr. Lin a chair. */
export const membership: Membership = {
  [SAM]: [STUDENTS_GROUP],
  [LIN]: [CHAIRS_GROUP],
}

/** The grants that apply to one person of the cast (AC-1): its own, and those of its groups. */
export function grantsOfPerson(person: ActorId): readonly Grant[] {
  const groups = (membership[person] ?? []).map((group) => `group:${group}`)
  return bootstrap.filter((grant) => grant.principal === person || groups.includes(grant.principal))
}

/**
 * The directory of the example flow for an instance that Sam started with
 * these values (AS-1, AS-4): the same resolver as the release server, over
 * the registrar team and the CS-Chairs group. A story builds its declared
 * events through it, so they equal what the server resolves.
 */
export function directory(values: ConditionData, starter: ActorId = SAM): TargetResolver {
  return resolverFor(
    starter,
    values,
    new Map([[REGISTRAR_TEAM, REGISTRAR_MEMBERS]]),
    new Map([
      [CHAIRS_GROUP, [LIN]],
      [STUDENTS_GROUP, [SAM]],
    ])
  )
}

/** The injected sources of step `index` (I6): the step clock and the `op-N` id, as `stepOperation` builds them. */
export function depsFor(index: number): OperationDeps {
  return { clock: () => index + 1, ids: () => `op-${index + 1}` }
}

/**
 * The step that declares an engine operation (ADR 0010): its actor, its type,
 * its payload without the outbox, and its outbox; with the intent a client
 * posts for it when the step is one. The harness checks that the server
 * resolves the intent to exactly this event.
 */
export function declared(operation: Operation, intent?: Readonly<Record<string, unknown>>): Step {
  const { outbox: _outbox, ...payload } = operation.payload
  const outbox = outboxOf(apply(operation, emptyState).log)
  return {
    actor: operation.actor ?? '',
    type: operation.type,
    payload,
    ...(outbox.length > 0 ? { outbox } : {}),
    ...(intent === undefined ? {} : { intent }),
  }
}

/**
 * The setup steps of a story on the example flow: Dana pushes and publishes
 * version 1 (S01, DF-2) and creates the registrar team with its members
 * (AS-6). They are the first steps of a story, so their indexes start at 0.
 */
export function setupSteps(definition: FlowDefinition = definitionV1): readonly Step[] {
  const pushed = push(createFlow(SLUG), definition, depsFor(0), DANA)
  const published = publish(pushed.flow, depsFor(1), DANA)
  const build: Step[] = [declared(pushed.operation), declared(published.operation)]
  const created = { team: REGISTRAR_TEAM, change: 'created' }
  const team: Step[] = [
    { actor: DANA, type: TEAM_CHANGE_TYPE, payload: created, intent: created },
    ...REGISTRAR_MEMBERS.map((member) => {
      const change = { team: REGISTRAR_TEAM, change: 'member-added', member }
      return { actor: DANA, type: TEAM_CHANGE_TYPE, payload: change, intent: change }
    }),
  ]
  return [...build, ...team]
}

/** How many setup steps `setupSteps` declares: the next story step has this index. */
export const SETUP_LENGTH = 6

/**
 * The server state a browser path starts from (DF-2): version 1 published,
 * as `setupSteps` records it, without the team steps. The gui runner seeds
 * the harness server with it, so the page reads the flow and the engine
 * resolves the intents against it.
 */
export function exampleFlowState(definition: FlowDefinition = definitionV1): State {
  const deps = (id: string): OperationDeps => ({ clock: () => 0, ids: () => id })
  const pushed = push(createFlow(SLUG), definition, deps('flow-push'), DANA)
  const published = publish(pushed.flow, deps('flow-publish'), DANA)
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/** The instance id that Sam's start mints in every story (DX-1, I6). */
export const INSTANCE_ID = 'inst-1'

/** Sam's request: a summary, the overload credits and Dr. Okafor as his advisor (FM-7). */
export function samValues(credits: number): ConditionData {
  return { summary: 'three extra credits', overload_credits: credits, advisor: OKAFOR }
}

/** The state after the steps, replayed from the declared events (I6). */
export function stateAfter(steps: readonly Step[]): State {
  let state = emptyState
  steps.forEach((step, index) => {
    state = apply(stepOperation(step, index), state)
  })
  return state
}

/** The instance as the log projects it after the steps (I4). */
export function instanceAfter(steps: readonly Step[], id: string = INSTANCE_ID): ProjectedInstance {
  const instance = instanceOf(stateAfter(steps).log, id)
  if (instance === undefined) throw new Error(`the steps hold no instance ${id}`)
  return instance
}

/**
 * A fixed operation source for a seeded state (I6, #269): the id names the
 * seeded event and `at` places it. A browser path starts from a seeded
 * state, and its own steps mint `op-N` from index 0, so a seeded id never
 * collides with a step's.
 */
export function seedDeps(id: string, at = 0): OperationDeps {
  return { clock: () => at, ids: () => id }
}

/**
 * The example flow and the registrar team with its members, as a browser
 * path starts from them (DF-2, AS-6, #269): `exampleFlowState` plus the team
 * steps of `setupSteps`, under seeded ids.
 */
export function exampleTeamState(definition: FlowDefinition = definitionV1): State {
  let state = exampleFlowState(definition)
  const dana = grantsOfPerson(DANA)
  const created = createTeam(REGISTRAR_TEAM, DANA, seedDeps('seed-team'), dana)
  state = apply(created.operation, state)
  let team = created.team
  for (const member of REGISTRAR_MEMBERS) {
    const added = addTeamMember(team, member, DANA, seedDeps(`seed-team-${member}`), dana)
    team = added.team
    state = apply(added.operation, state)
  }
  return state
}

/** The flow and the definition a seeded request runs on (DF-2). */
export type SeedFlow = {
  readonly flow: Flow
  readonly definition: FlowDefinition
}

/**
 * The state after Sam started and submitted his request (S06, ADR 0014,
 * #269): the request waits at the advisor step, under seeded ids at time 0.
 */
export function seedSubmitted(
  state: State,
  values: ConditionData,
  on: SeedFlow = { flow, definition: definitionV1 }
): State {
  const resolve = directory(values)
  const sam = grantsOfPerson(SAM)
  const started = startInstance(
    on.flow,
    INSTANCE_ID,
    values,
    SAM,
    seedDeps('seed-start'),
    resolve,
    sam
  )
  const next = apply(started.operation, state)
  const submitted = submitInstance(
    started.instance,
    SAM,
    {},
    0,
    { flow: SLUG, definition: on.definition, resolve, grants: sam, owner: SAM },
    seedDeps('seed-submit')
  )
  if (submitted.operation === undefined) throw new Error(submitted.reason)
  return apply(submitted.operation, next)
}

/**
 * The state after Dr. Okafor claimed and approved the request (S09, #269):
 * with a two-credit overload the chair step is skipped, so the request waits
 * at the registrar step, under seeded ids at time 0.
 */
export function seedApproved(
  state: State,
  values: ConditionData,
  on: SeedFlow = { flow, definition: definitionV1 }
): State {
  const resolve = directory(values)
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the seed holds no instance')
  const claimed = claim(instance, OKAFOR, instance.version ?? 0, seedDeps('seed-okafor-claim'))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  const next = apply(claimed.operation, state)
  const held = instanceOf(next.log, INSTANCE_ID)
  if (held === undefined) throw new Error('the seed holds no instance')
  const approved = complete(
    held,
    OKAFOR,
    'approve',
    {},
    held.version ?? 0,
    { flow: SLUG, definition: on.definition, grants: grantsOfPerson(OKAFOR), resolve, owner: SAM },
    seedDeps('seed-okafor-approve')
  )
  if (approved.operation === undefined) throw new Error(approved.reason)
  return apply(approved.operation, next)
}

/** The state after one more seeded claim by `who` (S09, AS-2, #269). */
export function seedClaimed(state: State, who: ActorId): State {
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the seed holds no instance')
  const claimed = claim(instance, who, instance.version ?? 0, seedDeps(`seed-claim-${who}`))
  if (claimed.operation === undefined) throw new Error(claimed.reason)
  return apply(claimed.operation, state)
}
