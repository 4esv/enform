// Issue #234, DE-4, ID-6, DF-1, DF-2, WF-1, AS-1, AS-6, AC-1, AC-2, AC-4,
// I4, I14: the demo seed and its clear. `seed demo` builds a demo organization
// through the real engine operations and the real Keycloak directory, and
// marks every record it created in `seed_records`. `seed clear` removes only
// those records. The log is append-only (I4): a clear appends one
// `seed.cleared@1` event and the projection reads exclude the cleared demo.
//
// The seed is deliberately a caller of the engine: the flow is pushed and
// published through `flow.ts`, the teams and grants are configuration
// operations, and the instances start, claim and complete through
// `submission.ts` and `action.ts`. Nothing here writes a domain row directly;
// the seeded state is one more honest run over the log.

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { claim, complete } from '../engine/action.js'
import type { Grant } from '../engine/authorize.js'
import type { FlowDefinition } from '../engine/definition.js'
import { changeTitle, createFlow, publish, push } from '../engine/flow.js'
import { addGrant } from '../engine/grants.js'
import type { Operation, OperationDeps } from '../engine/operation.js'
import type { TargetResolver } from '../engine/routing.js'
import { startInstance, submitInstance } from '../engine/submission.js'
import { addTeamMember, createTeam } from '../engine/teams.js'
import type { Config } from './config.js'
import {
  appendSeedRun,
  clearSeedRecords,
  type NewSeedRecord,
  readSeedRecords,
  type SeedRecord,
} from './db.js'
import { newOperationId } from './ids.js'
import { createDirectoryUser, deleteDirectoryUser } from './keycloak.js'

/** The profile name that every demo record carries (DE-4). */
export const DEMO_PROFILE = 'demo'

/** The actor that a clear appends to the log. The directory has no caller identity here. */
const SEED_ACTOR = 'system:seed'

/** The title that the demo flow shows in the list. */
const DEMO_TITLE = 'Course Overload'

/** One demo user and the password that the run prints once (DE-4, ID-6). */
export type DemoUser = {
  readonly role: 'starter' | 'advisor' | 'registrar' | 'chair' | 'reader'
  readonly displayName: string
  readonly email: string
  readonly id: string
  readonly password: string
}

/** One seeded instance and the step it is on (DE-4). */
export type DemoInstance = {
  readonly id: string
  readonly step: string
  readonly done: boolean
}

/** The result of `seed demo`. */
export type SeedDemoResult = {
  readonly profile: typeof DEMO_PROFILE
  readonly alreadySeeded: boolean
  readonly run?: string
  readonly flow?: { readonly slug: string; readonly title: string; readonly url: string }
  readonly users?: readonly DemoUser[]
  readonly teams?: readonly { readonly name: string; readonly members: readonly string[] }[]
  readonly instances?: readonly DemoInstance[]
  readonly records?: number
}

/** The result of `seed clear`: the records that the clear removed, by kind. */
export type ClearDemoResult = {
  readonly profile: typeof DEMO_PROFILE
  readonly cleared: {
    readonly users: readonly SeedRecord[]
    readonly teams: readonly SeedRecord[]
    readonly flows: readonly SeedRecord[]
    readonly instances: readonly SeedRecord[]
    readonly grants: readonly SeedRecord[]
  }
  readonly operationId: string
}

/** The engine sources of one seed run: a monotonic clock and a UUIDv7 operation id. */
function operationDeps(): OperationDeps {
  let tick = Date.now()
  return {
    clock: () => {
      tick += 1
      return tick
    },
    ids: () => newOperationId(tick),
  }
}

/** Load the demo organization, or report that a live demo profile already exists (DE-4). */
export async function seedDemo(config: Config, pool: Pool): Promise<SeedDemoResult> {
  const live = await readSeedRecords(pool, DEMO_PROFILE, true)
  if (live.length > 0) {
    return { profile: DEMO_PROFILE, alreadySeeded: true, records: live.length }
  }

  const run = randomUUID().slice(0, 8)
  const deps = operationDeps()
  const baseAt = deps.clock()
  const email = (role: string): string => `${role}.${run}@demo.local`
  const cast: readonly {
    role: DemoUser['role']
    displayName: string
    email: string
  }[] = [
    { role: 'starter', displayName: 'Sam Starter', email: email('sam') },
    { role: 'advisor', displayName: 'Okafor Advisor', email: email('okafor') },
    { role: 'registrar', displayName: 'Ana Registrar', email: email('ana') },
    { role: 'registrar', displayName: 'Lee Registrar', email: email('lee') },
    { role: 'chair', displayName: 'Lin Chair', email: email('lin') },
    { role: 'reader', displayName: 'Priya Reader', email: email('priya') },
  ]

  const users: DemoUser[] = []
  for (const person of cast) {
    const created = await createDirectoryUser(config, {
      email: person.email,
      displayName: person.displayName,
    })
    users.push({ ...person, id: created.id, password: created.temporaryPassword })
  }
  const sam = requireUser(users, 'starter')
  const okafor = requireUser(users, 'advisor')
  const ana = requireNamedUser(users, 'Ana')
  const lee = requireNamedUser(users, 'Lee')
  const lin = requireUser(users, 'chair')
  const priya = requireUser(users, 'reader')

  const slug = `demo-course-overload-${run}`
  const registrarTeam = `registrar-office-${run}`
  const chairsTeam = `chairs-${run}`
  const flowResource = `flow:${slug}`
  const stepResource = (step: string): string => `${flowResource}/step:${step}`

  const grants: readonly Grant[] = [
    { principal: lin.id, resource: 'org', scopes: ['org.teams'] },
    { principal: lin.id, resource: flowResource, scopes: ['flow.build', 'flow.read'] },
    { principal: sam.id, resource: flowResource, scopes: ['instance.start'] },
    { principal: sam.id, resource: stepResource('request'), scopes: ['step.outcome:submit'] },
    { principal: okafor.id, resource: flowResource, scopes: ['flow.read'] },
    {
      principal: okafor.id,
      resource: stepResource('advisor'),
      scopes: ['step.outcome:approve', 'step.outcome:send_back'],
    },
    { principal: registrarTeam, resource: flowResource, scopes: ['flow.read'] },
    {
      principal: registrarTeam,
      resource: stepResource('registrar'),
      scopes: ['step.outcome:approve'],
    },
    { principal: chairsTeam, resource: flowResource, scopes: ['flow.read'] },
    { principal: chairsTeam, resource: stepResource('chair'), scopes: ['step.outcome:approve'] },
    {
      principal: priya.id,
      resource: flowResource,
      scopes: ['instance.read', 'instance.timeline'],
    },
  ]
  const linGrants = grants.filter((grant) => grant.principal === lin.id)
  const samGrants = grants.filter((grant) => grant.principal === sam.id)
  const okaforGrants = grants.filter((grant) => grant.principal === okafor.id)
  const registrarGrants = grants.filter((grant) => grant.principal === registrarTeam)

  const definition: FlowDefinition = {
    schemaVersion: 2,
    steps: [
      {
        key: 'chair',
        targets: [{ team: chairsTeam }],
        outcomes: ['approve'],
        skipWhen: { '<=': [{ var: 'credits' }, 2] },
      },
      {
        key: 'request',
        targets: [{ starter: 'starter' }],
        fields: [
          { key: 'summary', control: 'text', label: 'Summary', required: true },
          { key: 'credits', control: 'number', label: 'Overload credits', required: true },
        ],
        editable: ['summary', 'credits'],
        outcomes: ['submit'],
      },
      {
        key: 'advisor',
        targets: [{ user: okafor.id }],
        outcomes: ['approve', 'send_back'],
      },
      {
        key: 'registrar',
        targets: [{ team: registrarTeam }],
        outcomes: ['approve'],
      },
    ],
  }

  const operations: Operation[] = []
  for (const grant of grants) operations.push(addGrant(grant, lin.id, deps))
  const registrarCreated = createTeam(registrarTeam, lin.id, deps, linGrants)
  operations.push(registrarCreated.operation)
  const registrarWithAna = addTeamMember(registrarCreated.team, ana.id, lin.id, deps, linGrants)
  operations.push(registrarWithAna.operation)
  const registrarWithLee = addTeamMember(registrarWithAna.team, lee.id, lin.id, deps, linGrants)
  operations.push(registrarWithLee.operation)
  const chairsCreated = createTeam(chairsTeam, lin.id, deps, linGrants)
  operations.push(chairsCreated.operation)
  const chairsWithLin = addTeamMember(chairsCreated.team, lin.id, lin.id, deps, linGrants)
  operations.push(chairsWithLin.operation)

  const pushed = push(createFlow(slug), definition, deps, lin.id, linGrants)
  operations.push(pushed.operation)
  const published = publish(pushed.flow, deps, lin.id, linGrants)
  operations.push(published.operation)
  operations.push(changeTitle(slug, DEMO_TITLE, deps, lin.id))
  const version = published.flow.versions[published.flow.versions.length - 1]
  const publishedDefinition = version.definition

  const teamMembers = new Map<string, readonly string[]>([
    [registrarTeam, [ana.id, lee.id]],
    [chairsTeam, [lin.id]],
  ])
  const resolveFor =
    (starter: string): TargetResolver =>
    (target) => {
      if ('user' in target) return [target.user]
      if ('starter' in target) return [starter]
      if ('team' in target) return teamMembers.get(target.team) ?? []
      return []
    }

  const instances: DemoInstance[] = []
  const start = (values: Record<string, string | number>) => {
    const instanceId = randomUUID()
    const started = startInstance(
      published.flow,
      instanceId,
      values,
      sam.id,
      deps,
      resolveFor(sam.id),
      samGrants
    )
    operations.push(started.operation)
    return { instanceId, instance: started.instance }
  }

  const take = (
    current: ReturnType<typeof start>['instance'],
    actor: string,
    actorGrants: readonly Grant[],
    outcome: string,
    values: Record<string, string | number>
  ) => {
    const claimed = claim(current, actor, current.version ?? 0, deps)
    if (!claimed.accepted || claimed.operation === undefined) {
      throw new Error(`seed: the claim of ${current.instanceId} was refused: ${claimed.reason}`)
    }
    operations.push(claimed.operation)
    const completed = complete(
      claimed.instance,
      actor,
      outcome,
      values,
      claimed.instance.version ?? 0,
      {
        flow: slug,
        definition: publishedDefinition,
        grants: actorGrants,
        resolve: resolveFor(sam.id),
      },
      deps
    )
    if (!completed.accepted || completed.operation === undefined) {
      throw new Error(
        `seed: the completion of ${current.instanceId} was refused: ${completed.reason}`
      )
    }
    operations.push(completed.operation)
    return completed.instance
  }

  const credits = { summary: 'Three extra credits for a graduating student', credits: 2 }

  // One started and not yet opened at the request step.
  const first = start(credits)
  instances.push({
    id: first.instanceId,
    step: first.instance.currentStep ?? 'request',
    done: false,
  })

  // One submitted by Sam, waiting for Okafor at the advisor step.
  const second = start(credits)
  const submitted = take(second.instance, sam.id, samGrants, 'submit', credits)
  const submit = submitInstance(submitted, sam.id, deps, credits)
  operations.push(submit.operation)
  instances.push({ id: second.instanceId, step: submitted.currentStep ?? 'advisor', done: false })

  // One approved by Okafor, waiting for the registrar team.
  const third = start(credits)
  const afterRequest = take(third.instance, sam.id, samGrants, 'submit', credits)
  const afterAdvisor = take(afterRequest, okafor.id, okaforGrants, 'approve', {})
  instances.push({
    id: third.instanceId,
    step: afterAdvisor.currentStep ?? 'registrar',
    done: false,
  })

  // One approved by the registrar and done.
  const fourth = start(credits)
  const fourthRequest = take(fourth.instance, sam.id, samGrants, 'submit', credits)
  const fourthAdvisor = take(fourthRequest, okafor.id, okaforGrants, 'approve', {})
  const fourthRegistrar = take(fourthAdvisor, ana.id, registrarGrants, 'approve', {})
  instances.push({
    id: fourth.instanceId,
    step: fourthRegistrar.currentStep ?? 'done',
    done: fourthRegistrar.done === true,
  })

  const records: NewSeedRecord[] = [
    ...users.map((user) => record('user', user.id, baseAt)),
    ...teamRecords([registrarTeam, chairsTeam], baseAt),
    record('flow', slug, baseAt),
    ...instances.map((instance) => record('instance', instance.id, baseAt)),
    ...grants.map((grant) => record('grant', grantRecordId(grant), baseAt)),
  ]
  await appendSeedRun(pool, operations, records)

  return {
    profile: DEMO_PROFILE,
    alreadySeeded: false,
    run,
    flow: {
      slug,
      title: DEMO_TITLE,
      url: `${config.publicUrl}/?flow=${encodeURIComponent(slug)}`,
    },
    users,
    teams: [
      { name: registrarTeam, members: [ana.id, lee.id] },
      { name: chairsTeam, members: [lin.id] },
    ],
    instances,
    records: records.length,
  }
}

/** Remove only the demo records, after deleting the demo users from Keycloak (DE-4). */
export async function clearDemo(config: Config, pool: Pool): Promise<ClearDemoResult> {
  const live = await readSeedRecords(pool, DEMO_PROFILE, true)
  const users = live.filter((record) => record.kind === 'user')
  for (const user of users) await deleteDirectoryUser(config, user.id)
  const cleared = await clearSeedRecords(pool, DEMO_PROFILE, Date.now(), SEED_ACTOR)
  const records = cleared.records.length > 0 ? cleared.records : live
  return {
    profile: DEMO_PROFILE,
    cleared: {
      users: records.filter((record) => record.kind === 'user'),
      teams: records.filter((record) => record.kind === 'team'),
      flows: records.filter((record) => record.kind === 'flow'),
      instances: records.filter((record) => record.kind === 'instance'),
      grants: records.filter((record) => record.kind === 'grant'),
    },
    operationId: cleared.operationId,
  }
}

/** The stable key of one seeded grant, so a clear deletes exactly that grant (DE-4). */
export function grantRecordId(grant: Grant): string {
  return JSON.stringify([grant.principal, grant.resource, grant.scopes])
}

/** One new seed record with the profile and the run time. */
function record(kind: NewSeedRecord['kind'], id: string, createdAt: number): NewSeedRecord {
  return { profile: DEMO_PROFILE, kind, id, createdAt }
}

/** The record of every seeded team. */
function teamRecords(names: readonly string[], createdAt: number): readonly NewSeedRecord[] {
  return names.map((name) => record('team', name, createdAt))
}

/** The one cast user with a role, or a named failure. */
function requireUser(users: readonly DemoUser[], role: DemoUser['role']): DemoUser {
  const user = users.find((entry) => entry.role === role)
  if (user === undefined) throw new Error(`seed: the demo cast has no ${role}`)
  return user
}

/** The one cast user whose display name starts with a token, or a named failure. */
function requireNamedUser(users: readonly DemoUser[], name: string): DemoUser {
  const user = users.find((entry) => entry.displayName.startsWith(name))
  if (user === undefined) throw new Error(`seed: the demo cast has no ${name}`)
  return user
}
