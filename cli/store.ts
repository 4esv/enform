// Issue #38, S01, DF-1, DF-2, DF-4, DX-3, I6, I9: the local `.enform/` store.
//
// The CLI is file-backed and in-process: a flow's draft and its published
// versions persist to `.enform/<slug>.json`, so separate `enform` invocations
// share one flow. The store is pure read and write (A9): it serializes the
// engine `Flow` value and reads it back, and it holds no correctness logic.
// The file is canonical and deterministic (I6, I9): each definition round
// trips through the engine's canonical form, so a repeated write of the same
// flow is byte for byte the same.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type FlowDefinition, type JsonValue, parse, serialize } from '../engine/definition.js'
import { createFlow, type Flow, type FlowVersion } from '../engine/flow.js'

/** The directory that holds the local store, under the working directory. */
const STORE_DIR = '.enform'

/** The path of the store file for one flow: `.enform/<slug>.json`. */
export function storePath(slug: string, cwd: string): string {
  return join(cwd, STORE_DIR, `${slug}.json`)
}

/**
 * Read a flow from the local store (DF-1, DF-4). A missing store file is a
 * fresh flow with an empty draft and no published version, so the first push
 * has a flow to apply to. The stored definitions are read through the engine's
 * parser, so a corrupt file fails with the engine's error and not a silent
 * value.
 */
export function readFlow(slug: string, cwd: string): Flow {
  const path = storePath(slug, cwd)
  if (!existsSync(path)) return createFlow(slug)
  let body: unknown
  try {
    body = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`store: ${path} is not valid JSON`)
  }
  return storedToFlow(slug, body)
}

/**
 * Write a flow to the local store (DF-1, DF-2, DF-4). The file is the
 * canonical serialization of the draft and the published versions, so a
 * repeated write of the same flow is byte for byte the same (I6, I9).
 */
export function writeFlow(slug: string, flow: Flow, cwd: string): void {
  const path = storePath(slug, cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeFlow(flow))
}

/** Serialize a flow to its canonical store form (I6, I9). */
function serializeFlow(flow: Flow): string {
  const stored: Record<string, unknown> = { slug: flow.slug }
  if (flow.draft !== undefined) stored.draft = canonicalValue(flow.draft)
  stored.versions = flow.versions.map((version) => ({
    version: version.version,
    contentHash: version.contentHash,
    definition: canonicalValue(version.definition),
  }))
  return `${JSON.stringify(stored, null, 2)}\n`
}

/** Read a stored flow file body back to a flow (the inverse of serializeFlow). */
function storedToFlow(slug: string, body: unknown): Flow {
  if (!isRecord(body)) throw new Error('store: the flow file is not an object')
  const flow: { slug: string; draft?: FlowDefinition; versions: readonly FlowVersion[] } = {
    slug,
    versions: readVersions(body.versions),
  }
  if (body.draft !== undefined) flow.draft = readDefinition(body.draft)
  return flow
}

/** Read the published versions of a stored flow; a missing list is no version. */
function readVersions(body: unknown): readonly FlowVersion[] {
  if (body === undefined) return []
  if (!Array.isArray(body)) throw new Error('store: versions must be an array')
  return body.map(readVersion)
}

/** Read one stored version: its number, its content hash and its frozen definition. */
function readVersion(body: unknown): FlowVersion {
  if (!isRecord(body)) throw new Error('store: a version is not an object')
  if (typeof body.version !== 'number') throw new Error('store: a version needs a number')
  if (typeof body.contentHash !== 'string') {
    throw new Error('store: a version needs a content hash')
  }
  return {
    version: body.version,
    contentHash: body.contentHash,
    definition: readDefinition(body.definition),
  }
}

/** Read a stored definition through the engine's canonical parser (I9). */
function readDefinition(body: unknown): FlowDefinition {
  if (body === undefined) throw new Error('store: a definition is missing')
  return parse(JSON.stringify(body))
}

/** The canonical JSON value of a definition, for the store file (I9). */
function canonicalValue(definition: FlowDefinition): JsonValue {
  const text = serialize(definition)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('store: the canonical definition is not valid JSON')
  }
  // SAFETY: the text is the engine's canonical serialization of a definition,
  // so the parsed value is the JSON value of that definition.
  return value as JsonValue
}

/** A JSON object: not null and not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
