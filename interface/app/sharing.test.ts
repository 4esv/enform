import { expect, test } from 'vitest'

// Issue #264, S02, AC-1, AC-3, AC-4, A9: the sharing panel of the builder.
// A preset such as "Approver" is a name the panel knows; it expands to
// scopes when the grant is made, and only scopes reach the engine (AC-3).
// The panel answers "Who can approve at the registrar step?" from the
// stored grants: the principals that hold `step.outcome:approve` on that
// step or on the flow (AC-4, MVP.md 5.6). The functions are pure, so the
// checks run in Node; the integration suite drives the panel in Chromium.

type Grant = { principal: string; scopes: readonly string[]; resource: string }

type Sharing = {
  PRESETS: readonly { key: string; label: string; scopes: readonly string[]; on: 'flow' | 'step' }[]
  grantFor: (input: {
    slug: string
    principal: string
    step?: string
    preset?: string
    scopes?: string
  }) => Grant | { error: string }
  whoCan: (
    grants: readonly Grant[],
    slug: string,
    step: string,
    outcome: string
  ) => readonly string[]
  describeGrant: (grant: Grant) => string
  principalOf: (text: string) => string
}

const SHARING_MODULE = new URL('./sharing.js', import.meta.url).href

async function sharing(): Promise<Sharing> {
  return (await import(SHARING_MODULE)) as unknown as Sharing
}

test('#264 S02 AC-3 a preset expands to scopes on the flow or on a step, and only scopes are stored', async () => {
  const { grantFor, PRESETS } = await sharing()
  expect(PRESETS.map((preset) => preset.key)).toEqual([
    'starter',
    'approver',
    'reviewer',
    'editor',
    'builder',
    'viewer',
  ])
  expect(
    grantFor({
      slug: 'course-overload',
      principal: 'user:lee',
      step: 'registrar',
      preset: 'approver',
    })
  ).toEqual({
    principal: 'lee',
    scopes: ['step.outcome:approve', 'step.outcome:reject'],
    resource: 'flow:course-overload/step:registrar',
  })
  expect(
    grantFor({
      slug: 'course-overload',
      principal: 'jordan',
      step: 'registrar',
      preset: 'reviewer',
    })
  ).toEqual({
    principal: 'jordan',
    scopes: ['step.outcome:send_back'],
    resource: 'flow:course-overload/step:registrar',
  })
  expect(
    grantFor({ slug: 'course-overload', principal: 'group:All-Students', preset: 'starter' })
  ).toEqual({
    principal: 'group:All-Students',
    scopes: ['instance.start'],
    resource: 'flow:course-overload',
  })
  expect(grantFor({ slug: 'course-overload', principal: 'user:priya', preset: 'editor' })).toEqual({
    principal: 'priya',
    scopes: ['flow.edit', 'flow.dryrun', 'instance.read', 'instance.timeline', 'task.reassign'],
    resource: 'flow:course-overload',
  })
  expect(grantFor({ slug: 'course-overload', principal: 'user:dana', preset: 'builder' })).toEqual({
    principal: 'dana',
    scopes: [
      'flow.build',
      'flow.edit',
      'flow.dryrun',
      'instance.read',
      'instance.timeline',
      'task.reassign',
    ],
    resource: 'flow:course-overload',
  })
  // Explicit scopes are a list; a step preset needs a step; nothing is a refusal.
  expect(
    grantFor({
      slug: 'course-overload',
      principal: 'team:registrar-office',
      scopes: 'instance.read, instance.timeline',
    })
  ).toEqual({
    principal: 'team:registrar-office',
    scopes: ['instance.read', 'instance.timeline'],
    resource: 'flow:course-overload',
  })
  expect(grantFor({ slug: 'course-overload', principal: 'user:lee', preset: 'approver' })).toEqual({
    error: 'the preset Approver applies to a step; choose one',
  })
  expect(grantFor({ slug: 'course-overload', principal: '', preset: 'starter' })).toEqual({
    error: 'name a principal: a user id, group:<name> or team:<slug>',
  })
  expect(grantFor({ slug: 'course-overload', principal: 'user:lee' })).toEqual({
    error: 'choose a preset or list the scopes',
  })
})

test('#264 S02 AC-4 the panel answers who can choose an outcome at a step from the stored scopes', async () => {
  const { whoCan, describeGrant, principalOf } = await sharing()
  const grants: Grant[] = [
    {
      principal: 'user:lee',
      scopes: ['step.outcome:approve', 'step.outcome:reject'],
      resource: 'flow:course-overload/step:registrar',
    },
    {
      principal: 'user:jordan',
      scopes: ['step.outcome:send_back'],
      resource: 'flow:course-overload/step:registrar',
    },
    {
      principal: 'group:CS-Chairs',
      scopes: ['step.outcome:approve'],
      resource: 'flow:course-overload/step:chair',
    },
    { principal: 'user:ana', scopes: ['step.outcome:approve'], resource: 'flow:course-overload' },
    { principal: 'user:dana', scopes: ['step.outcome:approve'], resource: 'flow:other' },
  ]
  expect(whoCan(grants, 'course-overload', 'registrar', 'approve')).toEqual([
    'user:lee',
    'user:ana',
  ])
  expect(whoCan(grants, 'course-overload', 'registrar', 'send_back')).toEqual(['user:jordan'])
  expect(whoCan(grants, 'course-overload', 'chair', 'approve')).toEqual([
    'group:CS-Chairs',
    'user:ana',
  ])
  expect(whoCan(grants, 'course-overload', 'chair', 'reject')).toEqual([])
  expect(describeGrant(grants[0])).toBe(
    'user:lee holds step.outcome:approve, step.outcome:reject on flow:course-overload/step:registrar'
  )
  expect(principalOf(' lee ')).toBe('lee')
  expect(principalOf('user:lee')).toBe('lee')
  expect(principalOf('group:CS-Chairs')).toBe('group:CS-Chairs')
  expect(principalOf('team:registrar-office')).toBe('team:registrar-office')
})
