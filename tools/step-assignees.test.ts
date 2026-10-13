import { expect, test } from 'vitest'
import { claim, complete } from '../engine/action.js'
import { apply, emptyState, type State } from '../engine/apply.js'
import type { Grant } from '../engine/authorize.js'
import type { ConditionData } from '../engine/condition.js'
import { type FlowDefinition, parse } from '../engine/definition.js'
import { createFlow, type Flow, publish, push } from '../engine/flow.js'
import { contentHash } from '../engine/instance.js'
import {
  type InstanceView,
  instanceOf,
  type ProjectedInstance,
  readInstance,
} from '../engine/instances.js'
import type { OperationDeps } from '../engine/operation.js'
import { createResolver, type Membership } from '../engine/resolve.js'
import type { TargetResolver } from '../engine/routing.js'
import { sendBack } from '../engine/sendBack.js'
import { startInstance, submitInstance } from '../engine/submission.js'

// Issue #194, AS-1, AS-4, I13, FM-3, FM-7, S06, S09, S11: the engine records
// the assignees of every step it enters, not only the first. A start records
// the first step's resolution; a completion and a send back record the step
// they move to, exactly as a start does. The projection then accumulates those
// resolutions, so `instance.assignees` covers every step the instance has
// entered, and a step entered twice (a send back, WF-3) keeps only its most
// recent resolution. The step-scoped read refreshes the live targets (group,
// team) through the caller's resolver before it authorizes and before it
// computes `editable`, while a dynamic target keeps the one-time members that
// the engine recorded (AS-4, I13).

const SLUG = 'course-overload'
const SAM = 'user:sam'
const ANA = 'user:ana'
const JORDAN = 'user:jordan'
const OKAFOR = 'user:okafor'
const LIN = 'user:lin'
const MANAGER = 'user:manager'

/** The instance id that the start mints (DX-1, #187): deterministic, like every injected source (I6). */
const INSTANCE_ID = 'inst-1'

/** The steps of the test flows (WF-1). */
const REQUEST = 'request'
const ADVISOR = 'advisor'
const REGISTRAR = 'registrar'

/** The principals that a live target names (AS-1, AS-4): a group and a team. */
const STUDENTS = 'group:students'
const REGISTRARS = 'team:registrar-office'

/** A two-step flow whose second step names a live group (AS-4). */
const groupDefinition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST}",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "editable": ["summary"],
      "outcomes": ["submit"]
    },
    {
      "key": "${REGISTRAR}",
      "targets": [{ "group": "${STUDENTS}" }],
      "fields": [{ "key": "decision", "control": "select", "options": ["approve"] }],
      "editable": ["decision"],
      "outcomes": ["approve"]
    }
  ]
}
`)

/** A two-step flow whose second step names a user, a directory principal that is not live (AS-1, AS-4). */
const userDefinition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST}",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "editable": ["summary"],
      "outcomes": ["submit"]
    },
    {
      "key": "${REGISTRAR}",
      "targets": [{ "user": "${OKAFOR}" }],
      "fields": [{ "key": "decision", "control": "select", "options": ["approve"] }],
      "editable": ["decision"],
      "outcomes": ["approve"]
    }
  ]
}
`)

/** A two-step flow whose second step names a dynamic field target (AS-1, I13). */
const fieldDefinition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST}",
      "targets": [{ "starter": "starter" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "editable": ["summary"],
      "outcomes": ["submit"]
    },
    {
      "key": "${ADVISOR}",
      "targets": [{ "field": "advisor" }],
      "fields": [{ "key": "note", "control": "text" }],
      "editable": ["note"],
      "outcomes": ["approve"]
    }
  ]
}
`)

/** A two-step flow whose first step names a live group and whose second step can send back (WF-3). */
const sendBackDefinition: FlowDefinition = parse(`{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "${REQUEST}",
      "targets": [{ "group": "${STUDENTS}" }],
      "fields": [{ "key": "summary", "control": "text" }],
      "visible": ["summary"],
      "editable": ["summary"],
      "outcomes": ["submit"]
    },
    {
      "key": "${REGISTRAR}",
      "targets": [{ "team": "${REGISTRARS}" }],
      "fields": [{ "key": "decision", "control": "select", "options": ["approve", "send_back"] }],
      "editable": ["decision"],
      "outcomes": ["approve", "send_back"]
    }
  ]
}
`)

/** A mutable injected directory (ID-4, AS-4): a live target re-reads its members on every call. */
type Directory = {
  readonly membership: Membership
  join(principal: string, member: string): void
  leave(principal: string, member: string): void
}

/** One directory for the test: a group, a team and users that resolve to their current members. */
function directory(initial: Readonly<Record<string, readonly string[]>>): Directory {
  const members = new Map(Object.entries(initial).map(([key, value]) => [key, [...value]]))
  return {
    membership: (principal) => members.get(principal) ?? [],
    join: (principal, member) => {
      members.set(principal, [...(members.get(principal) ?? []), member])
    },
    leave: (principal, member) => {
      members.set(
        principal,
        (members.get(principal) ?? []).filter((candidate) => candidate !== member)
      )
    },
  }
}

/** The resolver a caller builds for one step (AS-1, AS-4): the instance's values fix a dynamic target. */
function resolver(dir: Directory, data: ConditionData): TargetResolver {
  return createResolver(dir.membership, { data, starter: SAM, managerOf: MANAGER })
}

/** The flow of the test, ready for a start at version 1 (DF-2). */
function flowOf(definition: FlowDefinition): Flow {
  return {
    slug: SLUG,
    versions: [{ version: 1, contentHash: contentHash(definition), definition }],
  }
}

/** The injected sources of the test (I6): a fixed time and `op-N` IDs. */
function deps(): OperationDeps {
  let next = 0
  return {
    clock: () => 1_700_000_000_000,
    ids: () => {
      next += 1
      return `op-${next}`
    },
  }
}

/** A log with the definition published (DF-2), so the projection can pin the instance to it. */
function seeded(definition: FlowDefinition, sources: OperationDeps): State {
  const pushed = push(createFlow(SLUG), definition, sources, 'user:dana')
  const published = publish(pushed.flow, sources, 'user:dana')
  return apply(published.operation, apply(pushed.operation, emptyState))
}

/** The instance that the projection reads from the log; throws when it is absent. */
function projected(state: State): ProjectedInstance {
  const instance = instanceOf(state.log, INSTANCE_ID)
  if (instance === undefined) throw new Error('the log holds no instance')
  return instance
}

/** The status context of a read (S14): the flow, the definition, the log and the grants that apply. */
function context(state: State, definition: FlowDefinition, grants: readonly Grant[]) {
  return { flow: SLUG, definition, log: state.log, grants }
}

/** Advance the instance from the request step to the second step (S09, WF-1), with the given resolver. */
function advance(
  state: State,
  definition: FlowDefinition,
  grants: readonly Grant[],
  resolve: TargetResolver,
  sources: OperationDeps
): State {
  const flow = flowOf(definition)
  const started = startInstance(
    flow,
    INSTANCE_ID,
    { summary: 'hello' },
    SAM,
    sources,
    resolve,
    grants
  )
  let next = apply(started.operation, state)
  const opened = next.log.length
  const claimed = claim({ ...started.instance, version: opened }, SAM, opened, sources)
  if (!claimed.accepted || claimed.operation === undefined) throw new Error(claimed.reason)
  next = apply(claimed.operation, next)
  const completed = complete(
    claimed.instance,
    SAM,
    'submit',
    claimed.instance.version ?? 0,
    { flow: SLUG, definition, grants, resolve },
    sources
  )
  if (!completed.accepted || completed.operation === undefined) throw new Error(completed.reason)
  return apply(completed.operation, next)
}

test('#194 AS-4 a later step group target resolves live at read time for a member who joined after the start', () => {
  const sources = deps()
  const dir = directory({ [SAM]: [SAM], [STUDENTS]: ['user:lee'], [MANAGER]: [MANAGER] })
  const grants: readonly Grant[] = [
    { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
  ]
  const state = advance(
    seeded(groupDefinition, sources),
    groupDefinition,
    grants,
    resolver(dir, {}),
    sources
  )

  // The completion recorded the second step's resolution at that moment
  // (I13): the group held Lee only.
  const before = projected(state)
  expect(before.assignees.find((assignee) => assignee.step === REGISTRAR)).toEqual({
    step: REGISTRAR,
    target: { group: STUDENTS },
    members: ['user:lee'],
  })

  // Ana joins the group after the task was created (AS-4).
  dir.join(STUDENTS, ANA)

  // The recorded resolution alone does not make Ana an assignee, so without a
  // resolver she reads nothing (I8)...
  expect(readInstance(ANA, before, context(state, groupDefinition, []))).toBeUndefined()

  // ...and a read through the resolver refreshes the live group, so the
  // second step's editable field is hers (FM-3, AS-4).
  const view: InstanceView | undefined = readInstance(
    ANA,
    before,
    context(state, groupDefinition, []),
    resolver(dir, {})
  )
  expect(view?.editable).toEqual(['decision'])
})

test('#194 FM-3 a later step user target is an assignee of the step and reads its editable field', () => {
  const sources = deps()
  const dir = directory({ [SAM]: [SAM], [OKAFOR]: [OKAFOR], [MANAGER]: [MANAGER] })
  const grants: readonly Grant[] = [
    { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
  ]
  const state = advance(
    seeded(userDefinition, sources),
    userDefinition,
    grants,
    resolver(dir, {}),
    sources
  )

  // The completion recorded the second step's assignee (I13), so the read
  // authorizes Okafor through mayRead and shows the editable keys (FM-3).
  const instance = projected(state)
  expect(instance.assignees.find((assignee) => assignee.step === REGISTRAR)).toEqual({
    step: REGISTRAR,
    target: { user: OKAFOR },
    members: [OKAFOR],
  })
  const view: InstanceView | undefined = readInstance(
    OKAFOR,
    instance,
    context(state, userDefinition, [])
  )
  expect(view?.editable).toEqual(['decision'])
})

test('#194 I13 a dynamic field target keeps its one-time members when the field value changes', () => {
  const sources = deps()
  const dir = directory({ [SAM]: [SAM], [OKAFOR]: [OKAFOR], [LIN]: [LIN], [MANAGER]: [MANAGER] })
  const grants: readonly Grant[] = [
    { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
  ]
  const data: ConditionData = { summary: 'hello', advisor: OKAFOR }
  const started = startInstance(
    flowOf(fieldDefinition),
    INSTANCE_ID,
    data,
    SAM,
    sources,
    resolver(dir, data),
    grants
  )
  let state = seeded(fieldDefinition, sources)
  state = apply(started.operation, state)
  const opened = state.log.length
  const claimed = claim({ ...started.instance, version: opened }, SAM, opened, sources)
  if (!claimed.accepted || claimed.operation === undefined) throw new Error(claimed.reason)
  state = apply(claimed.operation, state)
  const completed = complete(
    claimed.instance,
    SAM,
    'submit',
    claimed.instance.version ?? 0,
    { flow: SLUG, definition: fieldDefinition, grants, resolve: resolver(dir, data) },
    sources
  )
  if (!completed.accepted || completed.operation === undefined) throw new Error(completed.reason)
  state = apply(completed.operation, state)

  // The field target resolved once, to the principal at the key then (I13).
  expect(projected(state).assignees.find((assignee) => assignee.step === ADVISOR)).toEqual({
    step: ADVISOR,
    target: { field: 'advisor' },
    members: [OKAFOR],
  })

  // The value changes. A dynamic target is not re-resolved at read time, so
  // the recorded member stays, and the new value does not move the task.
  const submitted = submitInstance(projected(state), SAM, sources, { advisor: LIN })
  state = apply(submitted.operation, state)
  const after = projected(state)
  expect(after.values?.advisor).toBe(LIN)

  const held = readInstance(
    OKAFOR,
    after,
    context(state, fieldDefinition, []),
    resolver(dir, { advisor: LIN })
  )
  expect(held?.editable).toEqual(['note'])
  expect(
    readInstance(LIN, after, context(state, fieldDefinition, []), resolver(dir, { advisor: LIN }))
  ).toBeUndefined()
})

test('#194 I13 the projection covers a step entered by a completion, and a send back replaces that step', () => {
  const sources = deps()
  const dir = directory({
    [SAM]: [SAM],
    [STUDENTS]: [SAM, ANA],
    [REGISTRARS]: [JORDAN],
    [MANAGER]: [MANAGER],
  })
  const submitGrants: readonly Grant[] = [
    { principal: SAM, scopes: ['instance.start', 'step.outcome:submit'], resource: `flow:${SLUG}` },
  ]
  const state = advance(
    seeded(sendBackDefinition, sources),
    sendBackDefinition,
    submitGrants,
    resolver(dir, {}),
    sources
  )

  // The completion recorded the registrar step's assignees (I13), so the
  // projection covers a step the instance entered after the start.
  const atRegistrar = projected(state)
  expect(atRegistrar.assignees).toEqual([
    { step: REQUEST, target: { group: STUDENTS }, members: [SAM, ANA] },
    { step: REGISTRAR, target: { team: REGISTRARS }, members: [JORDAN] },
  ])

  // Ana leaves the students group, and Jordan sends the task back to the
  // request step (WF-3). The send back records the request step's new
  // resolution, so the stale entry no longer holds.
  dir.leave(STUDENTS, ANA)
  const jordanGrants: readonly Grant[] = [
    {
      principal: JORDAN,
      scopes: ['step.outcome:send_back'],
      resource: `flow:${SLUG}/step:${REGISTRAR}`,
    },
  ]
  const held = { ...atRegistrar, version: state.log.length }
  const claimed = claim(held, JORDAN, held.version ?? 0, sources)
  if (!claimed.accepted || claimed.operation === undefined) throw new Error(claimed.reason)
  const withHolder = apply(claimed.operation, state)
  const sent = sendBack(
    claimed.instance,
    JORDAN,
    REQUEST,
    'please rework',
    claimed.instance.version ?? 0,
    {
      flow: SLUG,
      definition: sendBackDefinition,
      grants: jordanGrants,
      resolve: resolver(dir, {}),
    },
    sources
  )
  if (!sent.accepted || sent.operation === undefined) throw new Error(sent.reason)
  const afterSendBack = projected(apply(sent.operation, withHolder))

  expect(afterSendBack.assignees.find((assignee) => assignee.step === REQUEST)).toEqual({
    step: REQUEST,
    target: { group: STUDENTS },
    members: [SAM],
  })
  expect(afterSendBack.assignees.some((assignee) => assignee.members.includes(ANA))).toBe(false)
  expect(
    readInstance(ANA, afterSendBack, context(withHolder, sendBackDefinition, []), resolver(dir, {}))
  ).toBeUndefined()
})
