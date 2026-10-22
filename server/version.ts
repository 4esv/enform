// Issue #214, DE-2, DE-3, ADR 0011: the product version that `enform version`
// and `GET /version` report. The build reads it from `package.json`, which is
// the one place that a release bumps; a missing file falls back to `0.0.0` so
// a source checkout still answers.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The version of the running enform build (DE-2). */
export const VERSION = readVersion()

/** The line that `enform version` prints and `GET /version` answers. */
export function versionLine(): string {
  return `enform ${VERSION}`
}

/**
 * Read `version` from the nearest `package.json`. The emitted layout is
 * `dist/server/version.js` beside `dist/...`, so a release image places
 * `package.json` one or two directories above the module; a source checkout
 * has it one directory above `server/`.
 */
function readVersion(): string {
  const candidates = ['../package.json', '../../package.json', '../../../package.json']
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && /^\d+\.\d+\.\d+/.test(parsed.version)) {
        return parsed.version
      }
    } catch {
      // A malformed package.json is not a version; try the next candidate.
    }
  }
  return '0.0.0'
}
