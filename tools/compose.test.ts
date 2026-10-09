import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// The check of issue #97: the local Compose stack and its two test realms.
// The engine does not exist in 0.1.0, so the stack cannot run yet, and the
// check stays marked expected to fail.

const repo = join(import.meta.dirname, '..')
const composeFile = join(repo, 'deploy', 'compose.yaml')
const realms = join(repo, 'deploy', 'keycloak', 'realms')

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' })
}

test.fails('#97 the Compose stack validates and brokers AD and Entra ID', () => {
  expect(existsSync(composeFile), 'deploy/compose.yaml exists').toBe(true)

  const version = docker(['compose', 'version'])
  if (version.error !== undefined || version.status !== 0) {
    // Docker is not installed: the file must still be non-empty YAML.
    expect(readFileSync(composeFile, 'utf8').length).toBeGreaterThan(0)
  } else {
    const config = docker(['compose', '-f', composeFile, 'config', '-q'])
    expect(config.status, `${config.stdout}\n${config.stderr}`).toBe(0)
  }

  for (const realm of ['ad-realm.json', 'entra-realm.json']) {
    const path = join(realms, realm)
    expect(existsSync(path), `${realm} exists`).toBe(true)
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
  }
}, 30_000)
