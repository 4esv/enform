import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  databaseUrlForRun,
  freePort,
  queryDatabase,
  type TestConfig,
  testConfig,
} from './config.js'
import { type EnformProcess, startEnform } from './server.js'

// Issue #266, DE-5, DE-2, I4, D3: the documented operating procedures, run
// against the real stack. `enform doctor` reports the version with its
// checks; `enform migrate` is idempotent, so an upgrade runs it on a migrated
// store without harm; `enform admin backup` writes the log and the
// operational state beside it to one file, and `enform admin restore` loads
// that file into an empty store and rebuilds the projections, so the restored
// store answers exactly like the one that was backed up. A restore into a
// store that already holds a log is refused, because the log is append-only
// (I4) and a merge of two logs has no meaning.

const RUN = randomUUID().slice(0, 8)
const ADMIN_EMAIL = `ops-admin-${RUN}@test.local`
const ADMIN_PASSWORD = 'ops-admin-password'
const REPO = join(import.meta.dirname, '..')

type Setup = {
  readonly config: TestConfig
  readonly dir: string
  readonly configPath: string
  readonly databaseUrl: string
  readonly publicUrl: string
  readonly service: EnformProcess
}

/** The JSON body of `enform doctor --json`. */
type DoctorOutput = {
  readonly ok: boolean
  readonly version?: string
  readonly checks: readonly {
    readonly name: string
    readonly ok: boolean
    readonly detail: string
  }[]
}

/** The JSON body of `enform admin backup --json` and `enform admin restore --json`. */
type BackupOutput = {
  readonly ok: boolean
  readonly file?: string
  readonly events?: number
  readonly error?: string
}

let setup: Setup | undefined
let setupError: unknown

beforeAll(async () => {
  try {
    const config = testConfig()
    const dir = mkdtempSync(join(tmpdir(), 'enform-ops-'))
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
        '--smtp-url',
        config.smtpUrl,
        '--mail-from',
        config.mailFrom,
        '--no-open',
      ],
      publicUrl
    )
    setup = { config, dir, configPath, databaseUrl, publicUrl, service }
  } catch (error) {
    setupError = error
  }
}, 120_000)

afterAll(async () => {
  await setup?.service.stop()
  if (setup !== undefined) rmSync(setup.dir, { recursive: true, force: true })
})

function requireSetup(): Setup {
  if (setup === undefined) throw setupError ?? new Error('integration: the setup did not run')
  return setup
}

/** Run one CLI command and return its result. */
function runCli(args: readonly string[]): {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
} {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'cli', 'main.ts'), ...args],
    { cwd: REPO, encoding: 'utf8' }
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The rows that describe a store's content, so two stores compare as text. */
function storeShape(databaseUrl: string): Record<string, string[]> {
  return {
    events: queryDatabase(
      databaseUrl,
      "select seq, operation_id, type, at, coalesce(actor, '') from events order by seq"
    ),
    flows: queryDatabase(databaseUrl, 'select slug, draft_version from flows order by slug'),
    instances: queryDatabase(
      databaseUrl,
      'select id, flow_slug, status from instances order by id'
    ),
    grants: queryDatabase(
      databaseUrl,
      "select principal, resource, array_to_string(scopes, ',') from grants order by 1, 2, 3"
    ),
    seedRecords: queryDatabase(
      databaseUrl,
      "select profile, kind, id, coalesce(cleared_at::text, '') from seed_records order by 1, 2, 3"
    ),
    outbox: queryDatabase(databaseUrl, 'select id, status, attempts from outbox order by id'),
  }
}

test('#266 DE-5 doctor reports the version, migrate is idempotent, and a backup restores into an empty store', async () => {
  const { configPath, databaseUrl, dir, config } = requireSetup()

  // The demo seed gives the store flows, instances, grants, outbox rows and
  // seed records, so the backup carries every kind of state (DE-4).
  const seeded = runCli(['seed', 'demo', '--config', configPath, '--json'])
  expect(seeded.status, seeded.stderr).toBe(0)

  // Doctor: every check passes and the version is reported (DE-5).
  const doctor = runCli(['doctor', '--config', configPath, '--json'])
  expect(doctor.status, doctor.stderr + doctor.stdout).toBe(0)
  const report = JSON.parse(doctor.stdout) as DoctorOutput
  expect(report.ok).toBe(true)
  expect(report.version, 'doctor reports the version').toMatch(/^\d+\.\d+\.\d+/)
  expect(report.checks.map((check) => check.name)).toEqual(
    expect.arrayContaining(['version', 'config', 'database', 'identity provider', 'email'])
  )
  const version = report.checks.find((check) => check.name === 'version')
  expect(version?.detail).toMatch(/\d+\.\d+\.\d+/)

  // Upgrade: migrate on a migrated store applies nothing and reports none pending.
  const migrate = runCli(['migrate', '--config', configPath, '--json'])
  expect(migrate.status, migrate.stderr).toBe(0)
  expect(JSON.parse(migrate.stdout)).toMatchObject({ ok: true, applied: [] })
  const status = runCli(['migrate', '--status', '--config', configPath, '--json'])
  expect(status.status, status.stderr).toBe(0)
  expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, pending: [] })

  // Backup: the file holds every event of the log.
  const file = join(dir, 'backup.json')
  const backup = runCli(['admin', 'backup', '--out', file, '--config', configPath, '--json'])
  expect(backup.status, backup.stderr + backup.stdout).toBe(0)
  const written = JSON.parse(backup.stdout) as BackupOutput
  expect(written.ok).toBe(true)
  expect(written.file).toBe(file)
  expect(existsSync(file)).toBe(true)
  const content = JSON.parse(readFileSync(file, 'utf8')) as {
    format: number
    version: string
    events: readonly { seq: number; operationId: string }[]
  }
  const eventCount = Number(queryDatabase(databaseUrl, 'select count(*) from events')[0])
  expect(eventCount).toBeGreaterThan(0)
  expect(written.events).toBe(eventCount)
  expect(content.format).toBe(1)
  expect(content.version).toMatch(/^\d+\.\d+\.\d+/)
  expect(content.events).toHaveLength(eventCount)

  // Restore: into a fresh store, the restore migrates, loads the log, the
  // seed records and the delivery state, and rebuilds the projections.
  const restoredUrl = databaseUrlForRun(config.databaseUrl)
  const restore = runCli([
    'admin',
    'restore',
    file,
    '--config',
    configPath,
    '--database-url',
    restoredUrl,
    '--json',
  ])
  expect(restore.status, restore.stderr + restore.stdout).toBe(0)
  expect(JSON.parse(restore.stdout)).toMatchObject({ ok: true, events: eventCount })
  expect(storeShape(restoredUrl)).toEqual(storeShape(databaseUrl))

  // A store that already holds a log refuses a restore (I4).
  const refused = runCli(['admin', 'restore', file, '--config', configPath, '--json'])
  expect(refused.status).not.toBe(0)
  expect(`${refused.stderr}${refused.stdout}`).toMatch(/not empty|already holds/i)
  expect(storeShape(databaseUrl).events).toHaveLength(eventCount)
}, 180_000)
