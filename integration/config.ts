import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'

// Issue #213, DE-1, DE-3, ID-6, ADR 0012, ADR 0013: the environment of the
// integration suite. These tests run against a real PostgreSQL and a real
// Keycloak, the Compose services of deploy/compose.yaml, so an unset variable
// names itself instead of failing much later in a server or a query.

/** The environment of one integration run. */
export type TestConfig = {
  readonly databaseUrl: string
  readonly keycloakUrl: string
  readonly realm: string
  readonly keycloakAdmin: string
  readonly keycloakAdminPassword: string
  readonly clientId: string
  readonly clientSecret: string
}

/** Read the test environment, or name the variable that is missing. */
export function testConfig(): TestConfig {
  return {
    databaseUrl: required('ENFORM_TEST_DATABASE_URL'),
    keycloakUrl: required('ENFORM_TEST_KEYCLOAK_URL').replace(/\/+$/, ''),
    realm: optional('ENFORM_TEST_KEYCLOAK_REALM', 'enform-local'),
    keycloakAdmin: optional('ENFORM_TEST_KEYCLOAK_ADMIN', 'admin'),
    keycloakAdminPassword: optional('ENFORM_TEST_KEYCLOAK_ADMIN_PASSWORD', 'admin'),
    clientId: optional('ENFORM_TEST_CLIENT_ID', 'enform'),
    clientSecret: optional('ENFORM_TEST_CLIENT_SECRET', 'enform-dev-secret'),
  }
}

/**
 * A database URL whose name carries a per-run suffix, so two runs against the
 * same PostgreSQL do not drop each other's schema. `enform init` creates the
 * database that the URL names (DE-1).
 */
export function databaseUrlForRun(
  baseUrl: string,
  suffix: string = randomUUID().slice(0, 8)
): string {
  const url = new URL(baseUrl)
  const name = url.pathname.replace(/^\//, '') || 'enform'
  url.pathname = `/${name}_${suffix}`
  return url.toString()
}

/** A free TCP port on loopback, for the server that a test starts. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('integration: could not read the free port')))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

/**
 * Read one column from the test database with the PostgreSQL client. The
 * client is an integration prerequisite, like the database and Keycloak
 * themselves: it is how the suite proves that `init` created the schema.
 */
export function queryDatabase(databaseUrl: string, sql: string): string[] {
  const result = spawnSync('psql', [databaseUrl, '-w', '-Atq', '-F', '\t', '-c', sql], {
    encoding: 'utf8',
  })
  if (result.error !== undefined) {
    throw new Error(
      `integration: the psql client is required to read the test database: ${result.error.message}`
    )
  }
  if (result.status !== 0) {
    throw new Error(`integration: psql failed: ${result.stderr.trim()}`)
  }
  const output = result.stdout.trim()
  return output === '' ? [] : output.split('\n')
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`integration: set ${name} to run the integration suite`)
  }
  return value
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}
