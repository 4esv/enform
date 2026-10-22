// Issue #214, DE-1, ID-6, ADR 0011, ADR 0012: the bootstrap that `enform init`
// and `enform admin create` share. It creates the database when it is absent,
// applies the migrations, creates or updates the first administrator in the
// local directory and appends the administrator's grants. Every step is
// idempotent, so a second run adds no user and no duplicate grant.

import type { Pool } from 'pg'
import type { Grant } from '../engine/authorize.js'
import { addGrant } from '../engine/grants.js'
import type { OperationDeps } from '../engine/operation.js'
import type { Config } from './config.js'
import {
  appendOperation,
  createDatabaseIfMissing,
  createPool,
  hasGrant,
  runMigrations,
} from './db.js'
import { newOperationId } from './ids.js'
import { type AdministratorInput, ensureAdministrator } from './keycloak.js'

/** The scopes of the first administrator (MVP.md 5.6, DE-1). */
const ADMINISTRATOR_GRANTS: readonly Grant[] = [
  { principal: '', resource: 'org', scopes: ['org.grants'] },
  { principal: '', resource: '*', scopes: ['flow.build'] },
  { principal: '', resource: '*', scopes: ['instance.start'] },
  { principal: '', resource: '*', scopes: ['instance.read'] },
  { principal: '', resource: '*', scopes: ['instance.timeline'] },
  { principal: '', resource: '*', scopes: ['task.reassign'] },
]

/** The injected sources of a server-created operation (I6, ADR 0004). */
const deps: OperationDeps = { clock: () => Date.now(), ids: () => newOperationId() }

/** Run the whole bootstrap and return the administrator's immutable id (DE-1). */
export async function bootstrap(
  config: Config,
  administrator: AdministratorInput
): Promise<string> {
  await createDatabaseIfMissing(config.databaseUrl)
  const pool = createPool(config.databaseUrl)
  try {
    await runMigrations(pool)
    const id = await ensureAdministrator(config, administrator)
    await appendAdministratorGrants(pool, id)
    return id
  } finally {
    await pool.end()
  }
}

/** Append the grants that the first administrator holds, skipping ones already there. */
export async function appendAdministratorGrants(pool: Pool, principal: string): Promise<void> {
  for (const template of ADMINISTRATOR_GRANTS) {
    const grant: Grant = { ...template, principal }
    if (await hasGrant(pool, grant)) continue
    await appendOperation(pool, addGrant(grant, principal, deps))
  }
}
