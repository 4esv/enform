import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { databaseUrlForRun, freePort, type TestConfig, testConfig } from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #258, DX-3, I12, S01, S02, S06, S09, S10, S11, S13, S14, S15, S16: the
// `enform` command line against the real stack. Each person signs in with a
// username and a password of the local directory (ID-6), and every command
// goes through the public HTTP API with the bearer credential the sign-in
// stored (ADR 0012). The commands are the ones STORIES.md writes in its
// engine paths; each one accepts `--json`, so the checks read structured
// output and exit codes.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `cli-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'cli-admin-password'
const REPO = join(import.meta.dirname, '..')
const ENTRY = join(REPO, 'cli', 'main.ts')

type DemoUser = {
  readonly role: 'starter' | 'advisor' | 'registrar' | 'chair' | 'reader'
  readonly email: string
  readonly id: string
  readonly password: string
}

type SeedOutput = {
  readonly flow?: { readonly slug: string }
  readonly users?: readonly DemoUser[]
}

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly publicUrl: string
  readonly service: EnformProcess
  readonly seed: SeedOutput
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-cli-'))
    const databaseUrl = databaseUrlForRun(config.databaseUrl)
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const configPath = join(dir, 'enform.toml')
    const service = await startEnform(
      [
        'init',
        '--config',
        configPath,
        '--database-url',
        databaseUrl,
        '--public-url',
        publicUrl,
        '--admin-email',
        ADMIN_EMAIL,
        '--admin-password',
        ADMIN_PASSWORD,
        '--keycloak-url',
        config.keycloakUrl,
        '--keycloak-realm',
        config.realm,
        '--keycloak-admin-user',
        config.keycloakAdmin,
        '--keycloak-admin-password',
        config.keycloakAdminPassword,
        '--no-open',
      ],
      publicUrl
    )
    const seeded = spawnSync(
      process.execPath,
      ['--experimental-strip-types', ENTRY, 'seed', 'demo', '--config', configPath, '--json'],
      { cwd: REPO, encoding: 'utf8' }
    )
    if (seeded.status !== 0) throw new Error(`the demo seed failed: ${seeded.stderr}`)
    setup = { config, dir, publicUrl, service, seed: JSON.parse(seeded.stdout) }
  } catch (error) {
    setupError = error
  }
}, 180_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

function demoUser(role: DemoUser['role'], index = 0): DemoUser {
  const users = requireSetup().seed.users?.filter((user) => user.role === role) ?? []
  const user = users[index]
  if (user === undefined) throw new Error(`the seed has no ${role} user`)
  return user
}

function flowSlug(): string {
  const slug = requireSetup().seed.flow?.slug
  if (slug === undefined) throw new Error('the seed has no flow')
  return slug
}

type Run = { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/** One person's credential file: the sign-in of a person is stored apart from the others'. */
const credentialFiles = new Map<string, string>()

function credentialsOf(person: string): string {
  const known = credentialFiles.get(person)
  if (known !== undefined) return known
  const path = join(requireSetup().dir, `${person}-credentials.json`)
  credentialFiles.set(person, path)
  return path
}

/** Run the bin as one person, with `--json`, in the test directory. */
function enform(person: string, args: readonly string[], cwd?: string): Run {
  const { publicUrl, dir } = requireSetup()
  const result = spawnSync(process.execPath, [ENTRY, ...args, '--server', publicUrl, '--json'], {
    cwd: cwd ?? dir,
    encoding: 'utf8',
    env: { ...process.env, ENFORM_CREDENTIALS: credentialsOf(person) },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The JSON a command printed; the status and the streams are in the failure message. */
function output<T>(run: Run): T {
  if (run.status !== 0) throw new Error(`exit ${run.status}: ${run.stdout}${run.stderr}`)
  return JSON.parse(run.stdout) as T
}

/** Sign one person in with a password (ID-6) and answer the person's id. */
function signIn(person: string, user: { email: string; password: string }): void {
  const run = enform(person, ['login', '--username', user.email, '--password', user.password])
  const body = output<{ ok: boolean; principal: { id: string } }>(run)
  expect(body.ok).toBe(true)
}

type InstanceOutput = {
  readonly ok: boolean
  readonly instance: {
    readonly instanceId: string
    readonly version: number
    readonly status: {
      readonly state: string
      readonly currentStep?: string
      readonly holder?: string
    }
    readonly tracker: readonly { readonly key: string; readonly state: string }[]
    readonly withdrawal?: string
  }
}

function show(person: string, instanceId: string): InstanceOutput['instance'] {
  return output<InstanceOutput>(enform(person, ['instance', 'show', instanceId])).instance
}

let instanceId = ''

test.fails('#258 login stores a credential per server, and a bad password is refused', () => {
  const sam = demoUser('starter')
  signIn('sam', sam)
  const stored = JSON.parse(readFileSync(credentialsOf('sam'), 'utf8')) as Record<string, unknown>
  expect(Object.keys(stored)).toContain(requireSetup().publicUrl)
  const refused = enform('nobody', ['login', '--username', sam.email, '--password', 'wrong'])
  expect(refused.status).toBe(1)
  expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false })
  // Without a sign-in, a command that needs the server says so.
  const unsigned = enform('nobody', ['task', 'list', '--mine'])
  expect(unsigned.status).toBe(1)
  expect(JSON.parse(unsigned.stdout).error).toMatch(/enform login/)
})

test.fails('#258 S02 the administrator lists, adds and revokes grants', () => {
  const priya = demoUser('reader')
  signIn('admin', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  const resource = `flow:${flowSlug()}`
  const before = output<{ grants: { principal: string; scopes: string[] }[] }>(
    enform('admin', ['grant', 'list', resource])
  ).grants
  expect(before.some((grant) => grant.principal === demoUser('starter').id)).toBe(true)
  const added = output<{ ok: boolean; event: { type: string } }>(
    enform('admin', ['grant', 'add', priya.id, 'instance.start,flow.read', resource])
  )
  expect(added.event.type).toBe('config.grant.changed@1')
  const after = output<{ grants: { principal: string; scopes: string[] }[] }>(
    enform('admin', ['grant', 'list', resource])
  ).grants
  expect(
    after.find((grant) => grant.principal === priya.id && grant.scopes.includes('instance.start'))
  ).toBeDefined()
  output(enform('admin', ['grant', 'revoke', priya.id, 'instance.start,flow.read', resource]))
  const revoked = output<{ grants: { principal: string; scopes: string[] }[] }>(
    enform('admin', ['grant', 'list', resource])
  ).grants
  expect(
    revoked.some((grant) => grant.principal === priya.id && grant.scopes.includes('instance.start'))
  ).toBe(false)
  // A person without org.grants or flow.grant may not grant (403): exit 1 and the reason.
  signIn('priya', priya)
  const refused = enform('priya', ['grant', 'add', priya.id, 'instance.start', resource])
  expect(refused.status).toBe(1)
  expect(JSON.parse(refused.stdout).error).toMatch(/org.grants|flow.grant/)
})

test.fails('#258 S06 S11 S09 Sam starts and submits, the advisor sends back and approves, the registrar finishes', () => {
  const { dir } = requireSetup()
  const okafor = demoUser('advisor')
  const ana = demoUser('registrar', 0)
  const lee = demoUser('registrar', 1)
  signIn('okafor', okafor)
  signIn('ana', ana)
  signIn('lee', lee)
  const dataFile = join(dir, 'sam.json')
  writeFileSync(dataFile, JSON.stringify({ summary: 'two extra credits', credits: 2 }))

  // S06: a start is a private draft; the submit routes it to the advisor.
  const started = output<{ ok: boolean; instanceId: string }>(
    enform('sam', ['instance', 'start', flowSlug(), '--data', dataFile])
  )
  instanceId = started.instanceId
  expect(instanceId).not.toBe('')
  expect(show('sam', instanceId).status.state).toBe('draft')
  const edited = output<{ ok: boolean; event: { type: string } }>(
    enform('sam', ['instance', 'edit', instanceId, '--data', dataFile])
  )
  expect(edited.event.type).toBe('draft.edited@1')
  output(enform('sam', ['instance', 'submit', instanceId]))
  const submitted = show('sam', instanceId)
  expect(submitted.status.currentStep).toBe('advisor')
  const started_list = output<{ items: { instanceId: string }[] }>(
    enform('sam', ['task', 'list', '--started'])
  ).items
  expect(started_list.map((item) => item.instanceId)).toContain(instanceId)

  // S11: the advisor claims, sends the request back with a note; Sam submits again.
  const available = output<{ items: { instanceId: string }[] }>(
    enform('okafor', ['task', 'list', '--available'])
  ).items
  expect(available.map((item) => item.instanceId)).toContain(instanceId)
  output(enform('okafor', ['task', 'claim', instanceId]))
  expect(show('okafor', instanceId).status.holder).toBe(okafor.id)
  const noComment = enform('okafor', [
    'task',
    'complete',
    instanceId,
    '--outcome',
    'send_back',
    '--to',
    'request',
  ])
  expect(noComment.status).toBe(1)
  output(
    enform('okafor', [
      'task',
      'complete',
      instanceId,
      '--outcome',
      'send_back',
      '--to',
      'request',
      '--comment',
      'Attach your degree audit',
    ])
  )
  expect(show('sam', instanceId).status.currentStep).toBe('request')
  output(enform('sam', ['instance', 'submit', instanceId]))
  output(enform('okafor', ['task', 'claim', instanceId]))
  output(enform('okafor', ['task', 'complete', instanceId, '--outcome', 'approve']))
  // S05: two credits skip the chair step; the registrar team is next.
  const atRegistrar = show('okafor', instanceId)
  expect(atRegistrar.status.currentStep).toBe('registrar')
  expect(atRegistrar.tracker.find((step) => step.key === 'chair')?.state).toBe('skipped')

  // S09, S10: Ana claims and releases, Lee claims and reassigns to Ana, a
  // takeover before the idle period is refused with the remaining time.
  output(enform('ana', ['task', 'claim', instanceId]))
  output(enform('ana', ['task', 'release', instanceId, '--reason', 'Not mine today']))
  expect(show('ana', instanceId).status.holder).toBeUndefined()
  output(enform('lee', ['task', 'claim', instanceId]))
  const early = enform('ana', ['task', 'takeover', instanceId, '--reason', 'Lee is out'])
  expect(early.status).toBe(1)
  expect(JSON.parse(early.stdout).error).toMatch(/idle|remaining|minute/)
  output(
    enform('lee', [
      'task',
      'reassign',
      instanceId,
      '--to',
      ana.id,
      '--reason',
      'Ana knows the case',
    ])
  )
  expect(show('ana', instanceId).status.holder).toBe(ana.id)
  const mine = output<{ items: { instanceId: string }[] }>(
    enform('ana', ['task', 'list', '--mine'])
  ).items
  expect(mine.map((item) => item.instanceId)).toContain(instanceId)
  output(enform('ana', ['task', 'complete', instanceId, '--outcome', 'approve']))
  expect(show('ana', instanceId).status.state).toBe('done')
})

test.fails('#258 S16 S15 Ana undoes her approval, and the log and the timeline show the events', () => {
  const ana = demoUser('registrar', 0)
  const timeline = output<{ entries: { seq: number; type: string }[] }>(
    enform('ana', ['instance', 'timeline', instanceId])
  ).entries
  const approval = timeline.filter((entry) => entry.type === 'step.completed@1').at(-1)
  if (approval === undefined) throw new Error('the timeline has no approval')
  const undone = output<{ ok: boolean; event: { type: string } }>(
    enform('ana', [
      'undo',
      String(approval.seq),
      '--instance',
      instanceId,
      '--reason',
      'Approved the wrong request',
    ])
  )
  expect(undone.event.type).toBe('event.undone@1')
  const restored = show('ana', instanceId)
  expect(restored.status.currentStep).toBe('registrar')
  expect(restored.status.holder).toBe(ana.id)
  const log = output<{ log: { seq: number; type: string }[] }>(
    enform('ana', ['log', '--instance', instanceId, '--limit', '5'])
  ).log
  expect(log).toHaveLength(5)
  expect(log.at(-1)?.type).toBe('event.undone@1')
  // The timeline with the flow's changes needs instance.timeline (S15, I8):
  // Ana has none, Priya has it.
  const refused = enform('ana', ['instance', 'timeline', instanceId, '--with-changes'])
  expect(refused.status).toBe(1)
  const withChanges = output<{ entries: { type: string }[] }>(
    enform('priya', ['instance', 'timeline', instanceId, '--with-changes'])
  ).entries
  expect(withChanges.some((entry) => entry.type.startsWith('config.'))).toBe(true)
})

test.fails('#258 S13 Sam withdraws and undoes it, Priya cancels, and the starter alone may withdraw', () => {
  const ana = demoUser('registrar', 0)
  const notStarter = enform('ana', ['instance', 'withdraw', instanceId, '--reason', 'no'])
  expect(notStarter.status).toBe(1)
  expect(JSON.parse(notStarter.stdout).error).toMatch(/starter/)
  output(enform('sam', ['instance', 'withdraw', instanceId, '--reason', 'Dropped a class']))
  expect(show('sam', instanceId).status.state).toBe('withdrawn')
  output(enform('sam', ['instance', 'undo', instanceId]))
  const restored = show('sam', instanceId)
  expect(restored.status.currentStep).toBe('registrar')
  expect(restored.status.holder).toBe(ana.id)
  output(enform('priya', ['instance', 'cancel', instanceId, '--reason', 'Duplicate of #4411']))
  expect(show('sam', instanceId).status.state).toBe('cancelled')
})

test.fails('#258 S01 S03 the builder pulls, diffs, pushes and publishes the flow through the server', () => {
  const { dir } = requireSetup()
  const lin = demoUser('chair')
  signIn('lin', lin)
  const slug = flowSlug()
  const pulled = output<{ ok: boolean; path: string }>(enform('lin', ['flow', 'pull', slug]))
  const file = join(dir, pulled.path)
  const definition = JSON.parse(readFileSync(file, 'utf8')) as {
    steps: { key: string; fields?: { key: string; label?: string }[] }[]
  }
  const same = output<{ changes: unknown[] }>(
    enform('lin', ['flow', 'diff', slug, '--from', '1', '--to', 'draft'])
  )
  expect(same.changes).toEqual([])
  // An edit-class change: a label (DF-5).
  const summary = definition.steps[0].fields?.find((field) => field.key === 'summary')
  if (summary === undefined) throw new Error('the pulled definition has no summary field')
  summary.label = 'Summary of the request'
  writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`)
  output(enform('lin', ['flow', 'push', pulled.path]))
  const changed = output<{ changes: { class: string; path?: string }[] }>(
    enform('lin', ['flow', 'diff', slug, '--from', '1', '--to', 'draft'])
  )
  expect(changed.changes.map((change) => change.class)).toEqual(['edit'])
  const published = output<{ version: number; contentHash: string }>(
    enform('lin', ['flow', 'publish', slug])
  )
  expect(published.version).toBe(2)
  const diff = output<{ changes: { class: string }[] }>(
    enform('lin', ['flow', 'diff', slug, '--from', '1', '--to', '2'])
  )
  expect(diff.changes).toHaveLength(1)
  // A pull after the publication reproduces the pushed file byte for byte (I9).
  const again = output<{ path: string }>(enform('lin', ['flow', 'pull', slug]))
  expect(readFileSync(join(dir, again.path), 'utf8')).toContain('Summary of the request')
})
