// Issue #214, DE-2, DE-3, ADR 0011: the one configuration surface. Precedence
// is command-line flag, `ENFORM_*` environment, TOML file, default. The file is
// `/etc/enform/enform.toml` by default and `enform init` writes it with mode
// 0600. Secrets live in the file or the environment, never in the repository.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'smol-toml'

/** The identity provider settings of an installation (ADR 0012). */
export type KeycloakConfig = {
  readonly url: string
  readonly realm: string
  readonly clientId: string
  readonly clientSecret: string
  readonly adminUser: string
  readonly adminPassword: string
}

/** The session settings of an installation (ADR 0012). */
export type SessionConfig = {
  readonly cookieName: string
  readonly idleMinutes: number
  readonly absoluteHours: number
}

/** The configuration that `serve`, `migrate`, `worker`, `admin` and `doctor` read. */
export type Config = {
  readonly publicUrl: string
  readonly httpAddr: string
  readonly databaseUrl: string
  readonly keycloak: KeycloakConfig
  readonly session: SessionConfig
  readonly logLevel: string
}

/** The path that `enform init` writes when no `--config` is given (ADR 0011). */
export const DEFAULT_CONFIG_PATH = '/etc/enform/enform.toml'

/** The configuration before any file, environment or flag. */
export const defaultConfig: Config = {
  publicUrl: 'http://localhost:8080',
  httpAddr: '0.0.0.0:8080',
  databaseUrl: 'postgres://enform:enform@localhost:5432/enform',
  keycloak: {
    url: 'http://localhost:8081',
    realm: 'enform-local',
    clientId: 'enform',
    clientSecret: 'enform-dev-secret',
    adminUser: 'admin',
    adminPassword: 'admin',
  },
  session: {
    cookieName: 'enform_session',
    idleMinutes: 30,
    absoluteHours: 12,
  },
  logLevel: 'info',
}

/** The flags that name a configuration value, and the key it sets. */
const FLAG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  '--public-url': ['publicUrl'],
  '--http-addr': ['httpAddr'],
  '--database-url': ['databaseUrl'],
  '--log-level': ['logLevel'],
  '--keycloak-url': ['keycloak', 'url'],
  '--keycloak-realm': ['keycloak', 'realm'],
  '--keycloak-client-id': ['keycloak', 'clientId'],
  '--keycloak-client-secret': ['keycloak', 'clientSecret'],
  '--keycloak-admin-user': ['keycloak', 'adminUser'],
  '--keycloak-admin-password': ['keycloak', 'adminPassword'],
  '--session-cookie-name': ['session', 'cookieName'],
  '--session-idle-minutes': ['session', 'idleMinutes'],
  '--session-absolute-hours': ['session', 'absoluteHours'],
}

/** The environment variables that name a configuration value, and the key they set. */
const ENV_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ENFORM_PUBLIC_URL: ['publicUrl'],
  ENFORM_HTTP_ADDR: ['httpAddr'],
  ENFORM_DATABASE_URL: ['databaseUrl'],
  ENFORM_LOG_LEVEL: ['logLevel'],
  ENFORM_KEYCLOAK_URL: ['keycloak', 'url'],
  ENFORM_KEYCLOAK_REALM: ['keycloak', 'realm'],
  ENFORM_KEYCLOAK_CLIENT_ID: ['keycloak', 'clientId'],
  ENFORM_KEYCLOAK_CLIENT_SECRET: ['keycloak', 'clientSecret'],
  ENFORM_KEYCLOAK_ADMIN_USER: ['keycloak', 'adminUser'],
  ENFORM_KEYCLOAK_ADMIN_PASSWORD: ['keycloak', 'adminPassword'],
  ENFORM_SESSION_COOKIE_NAME: ['session', 'cookieName'],
  ENFORM_SESSION_IDLE_MINUTES: ['session', 'idleMinutes'],
  ENFORM_SESSION_ABSOLUTE_HOURS: ['session', 'absoluteHours'],
}

/** The deprecated OIDC names that an existing Compose file and unit may still carry. */
const OIDC_ENV_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ENFORM_OIDC_ISSUER_URL: ['keycloak', 'issuer'],
  ENFORM_OIDC_CLIENT_ID: ['keycloak', 'clientId'],
  ENFORM_OIDC_CLIENT_SECRET: ['keycloak', 'clientSecret'],
}

/** A mutable copy of the configuration keyed by the flat names above. */
type Draft = {
  publicUrl: string
  httpAddr: string
  databaseUrl: string
  logLevel: string
  keycloak: {
    url: string
    realm: string
    clientId: string
    clientSecret: string
    adminUser: string
    adminPassword: string
  }
  session: {
    cookieName: string
    idleMinutes: number
    absoluteHours: number
  }
}

/** Read the configuration: defaults, then file, then environment, then flags. */
export function loadConfig(
  flags: ReadonlyMap<string, readonly string[]>,
  env: NodeJS.ProcessEnv = process.env
): Config {
  const path = configPath(flags, env)
  const draft = draftOf(defaultConfig)
  const fromFile = existsSync(path)
    ? (parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {}
  const fromEnv = envValues(env)
  const fromFlags = flagValues(flags)

  applyValues(draft, fromFile)
  applyValues(draft, fromEnv)
  applyValues(draft, fromFlags)

  // `enform init` is given the public URL and no listen address, so the
  // server listens where the public URL points. An explicit address wins.
  if (
    !hasNested(fromFile, ['httpAddr']) &&
    !hasNested(fromEnv, ['httpAddr']) &&
    !hasNested(fromFlags, ['httpAddr'])
  ) {
    draft.httpAddr = addressOfUrl(draft.publicUrl)
  }

  return finalize(draft)
}

/** The configuration path: the `--config` flag, `ENFORM_CONFIG`, or the default. */
export function configPath(
  flags: ReadonlyMap<string, readonly string[]>,
  env: NodeJS.ProcessEnv = process.env
): string {
  return flags.get('--config')?.[0] ?? env.ENFORM_CONFIG ?? DEFAULT_CONFIG_PATH
}

/** Write the configuration with mode 0600, creating its directory (ADR 0011). */
export function writeConfig(config: Config, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${stringify(tomlOf(config))}\n`, { mode: 0o600 })
  // `writeFileSync` does not change the mode of an existing file.
  chmodSync(path, 0o600)
}

/** The issuer URL of the realm that the configuration names (ADR 0012). */
export function issuerUrl(config: Config): string {
  return `${config.keycloak.url.replace(/\/+$/, '')}/realms/${config.keycloak.realm}`
}

/** The `host:port` that the HTTP server binds. */
export function listenAddress(config: Config): { hostname: string; port: number } {
  const value = config.httpAddr.trim()
  const separator = value.lastIndexOf(':')
  if (separator === -1) return { hostname: '0.0.0.0', port: Number(value) }
  const hostname = value.slice(0, separator) || '0.0.0.0'
  const port = Number(value.slice(separator + 1))
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid http address: ${config.httpAddr}`)
  }
  return { hostname, port }
}

/** The listen address of a public URL, so `init` serves where it says. */
function addressOfUrl(publicUrl: string): string {
  const url = new URL(publicUrl)
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return `${url.hostname}:${port}`
}

/** The values that the environment carries, as nested paths. */
function envValues(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const values: Record<string, Record<string, unknown> | unknown> = {}
  for (const [name, path] of Object.entries(ENV_FIELDS)) {
    const value = env[name]
    if (value !== undefined && value !== '') setPath(values, path, value)
  }
  for (const [name, path] of Object.entries(OIDC_ENV_FIELDS)) {
    const value = env[name]
    if (value === undefined || value === '') continue
    if (path[1] === 'issuer') {
      const issuer = splitIssuer(value)
      setPath(values, ['keycloak', 'url'], issuer.url)
      setPath(values, ['keycloak', 'realm'], issuer.realm)
    } else {
      setPath(values, path, value)
    }
  }
  return values
}

/** The values that the command line carries, as nested paths. */
function flagValues(flags: ReadonlyMap<string, readonly string[]>): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [name, path] of Object.entries(FLAG_FIELDS)) {
    const found = flags.get(name)?.[0]
    if (found !== undefined) setPath(values, path, found)
  }
  return values
}

/** Split `http://host/realms/<realm>` into the base URL and the realm. */
function splitIssuer(value: string): { url: string; realm: string } {
  const marker = value.indexOf('/realms/')
  if (marker === -1) {
    return { url: value.replace(/\/+$/, ''), realm: defaultConfig.keycloak.realm }
  }
  const realm = value.slice(marker + '/realms/'.length).replace(/\/+$/, '')
  return { url: value.slice(0, marker), realm: realm === '' ? defaultConfig.keycloak.realm : realm }
}

/** Set one nested value. The path names a top-level field or a `[section]` field. */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  if (path.length === 1) {
    target[path[0]] = value
    return
  }
  const section = sectionOf(target[path[0]])
  if (section === undefined) {
    target[path[0]] = { [path[1]]: value }
    return
  }
  section[path[1]] = value
}

/** Whether a nested path is present. */
function hasNested(values: Record<string, unknown>, path: readonly string[]): boolean {
  if (path.length === 1) return values[path[0]] !== undefined
  const section = sectionOf(values[path[0]])
  return section !== undefined && section[path[1]] !== undefined
}

/** One nested section of a value map, or undefined when the value is not a table. */
function sectionOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  // SAFETY: the check above admits only a non-array object, which is the shape
  // that a TOML table parses to.
  return value as Record<string, unknown>
}

/** Apply a nested value map to a draft. */
function applyValues(draft: Draft, values: Record<string, unknown>): void {
  draft.publicUrl = text(values.publicUrl, draft.publicUrl)
  draft.httpAddr = text(values.httpAddr, draft.httpAddr)
  draft.databaseUrl = text(values.databaseUrl, draft.databaseUrl)
  draft.logLevel = text(values.logLevel, draft.logLevel)

  const keycloak = section(values.keycloak)
  if (keycloak !== undefined) {
    draft.keycloak.url = text(keycloak.url, draft.keycloak.url)
    draft.keycloak.realm = text(keycloak.realm, draft.keycloak.realm)
    draft.keycloak.clientId = text(keycloak.clientId, draft.keycloak.clientId)
    draft.keycloak.clientSecret = text(keycloak.clientSecret, draft.keycloak.clientSecret)
    draft.keycloak.adminUser = text(keycloak.adminUser, draft.keycloak.adminUser)
    draft.keycloak.adminPassword = text(keycloak.adminPassword, draft.keycloak.adminPassword)
  }

  const session = section(values.session)
  if (session !== undefined) {
    draft.session.cookieName = text(session.cookieName, draft.session.cookieName)
    draft.session.idleMinutes = numberValue(session.idleMinutes, draft.session.idleMinutes)
    draft.session.absoluteHours = numberValue(session.absoluteHours, draft.session.absoluteHours)
  }
}

/** A string field, or the value already in the draft. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** A number field, or the value already in the draft. */
function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return fallback
}

/** One `[section]` of a parsed TOML document. */
function section(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  // SAFETY: the check above admits only a non-array object, which is the shape
  // that a TOML table parses to.
  return value as Record<string, unknown>
}

/** A mutable copy of a configuration. */
function draftOf(config: Config): Draft {
  return {
    publicUrl: config.publicUrl,
    httpAddr: config.httpAddr,
    databaseUrl: config.databaseUrl,
    logLevel: config.logLevel,
    keycloak: { ...config.keycloak },
    session: { ...config.session },
  }
}

/** The configuration as a plain object, with the numeric fields coerced. */
function finalize(draft: Draft): Config {
  return {
    publicUrl: String(draft.publicUrl).replace(/\/+$/, ''),
    httpAddr: String(draft.httpAddr),
    databaseUrl: String(draft.databaseUrl),
    logLevel: String(draft.logLevel),
    keycloak: {
      url: String(draft.keycloak.url).replace(/\/+$/, ''),
      realm: String(draft.keycloak.realm),
      clientId: String(draft.keycloak.clientId),
      clientSecret: String(draft.keycloak.clientSecret),
      adminUser: String(draft.keycloak.adminUser),
      adminPassword: String(draft.keycloak.adminPassword),
    },
    session: {
      cookieName: String(draft.session.cookieName),
      idleMinutes: positiveNumber(draft.session.idleMinutes, 'session.idleMinutes'),
      absoluteHours: positiveNumber(draft.session.absoluteHours, 'session.absoluteHours'),
    },
  }
}

/** Coerce a configuration number, or name the field. */
function positiveNumber(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`invalid ${field}: ${String(value)}`)
  }
  return number
}

/** The TOML shape, with the numeric fields as numbers. */
function tomlOf(config: Config): Record<string, unknown> {
  return {
    publicUrl: config.publicUrl,
    httpAddr: config.httpAddr,
    databaseUrl: config.databaseUrl,
    logLevel: config.logLevel,
    keycloak: { ...config.keycloak },
    session: { ...config.session },
  }
}
