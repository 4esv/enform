import { randomBytes } from 'node:crypto'
import { uuidv7 } from '../engine/id.js'
import {
  appendOperation,
  type ClientConfig,
  type Event,
  type InstanceView,
  type Operation,
  readInstance,
  readSession,
  setClient,
} from '../interface/client/client.js'
import {
  type Credential,
  credentialsPath,
  freshCredential,
  normalizeServer,
  readCredential,
  rememberedServer,
  writeCredential,
} from './login.js'

// Issue #258, DX-3, DX-4, I12, ADR 0010, ADR 0012: the CLI's side of the
// public HTTP API. Every remote command signs its requests with the stored
// credential of the server, through the same generated client the interface
// uses (DX-4), and posts a client intent that the engine resolves (ADR 0010).
// The CLI decides nothing about the engine's state: it reads the instance
// for the version it acts on (I5), builds the intent and reports what the
// server answered.

/** The environment variable that names the server when `--server` is absent. */
export const SERVER_ENV = 'ENFORM_SERVER'

/** One signed-in session of the CLI: the server, the credential and the principal it acts as. */
export type RemoteSession = {
  readonly server: string
  readonly credential: Credential
  readonly principal: { readonly id: string; readonly displayName: string }
}

/**
 * The server a command talks to: `--server`, else `$ENFORM_SERVER`, else the
 * server of the last sign-in. Absent means the command works on the local
 * store (the file-backed `flow` commands) or needs a sign-in.
 */
export function serverOf(
  flags: ReadonlyMap<string, readonly string[]>,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const flagged = flags.get('--server')?.[0]
  if (flagged !== undefined && flagged !== '') return normalizeServer(flagged)
  const named = env[SERVER_ENV]
  if (named !== undefined && named !== '') return normalizeServer(named)
  return rememberedServer(credentialsPath(env))
}

/**
 * Sign the client with the stored credential of the server, refreshing it
 * when it is stale (ADR 0012), and read the principal the CLI acts as. A
 * server without a stored credential asks the person to run `enform login`.
 */
export async function openSession(
  server: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoteSession> {
  const path = credentialsPath(env)
  const stored = readCredential(path, server)
  if (stored === undefined) {
    throw new Error(`not signed in to ${server}; run enform login --server ${server}`)
  }
  const credential = await freshCredential(stored, { fetch, now: () => Date.now() })
  if (credential !== stored) writeCredential(path, server, credential)
  const config: ClientConfig = { baseUrl: server, token: credential.accessToken }
  setClient(config)
  const session = await readSession()
  return { server, credential, principal: session.principal }
}

/** The injected sources of the CLI (I6): the wall clock and a random UUIDv7 per operation. */
export function operationId(): string {
  return uuidv7(Date.now(), (length) => new Uint8Array(randomBytes(length)))
}

/** Post one client intent (ADR 0010) and answer the event the server appended. */
export async function postIntent(
  session: RemoteSession,
  type: string,
  payload: Readonly<Record<string, unknown>>
): Promise<Event> {
  const operation: Operation = {
    id: operationId(),
    type,
    at: Date.now(),
    actor: session.principal.id,
    payload: { ...payload },
  }
  return appendOperation(operation)
}

/** The instance as the acting principal reads it (I8), with the version an action is based on (I5). */
export async function currentInstance(instanceId: string): Promise<InstanceView> {
  return readInstance(instanceId)
}
