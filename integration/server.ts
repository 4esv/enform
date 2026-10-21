import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Issue #213, DE-1, DE-3, ADR 0011: run the real `enform` entry point as a
// child process and wait for its readiness endpoint. The tests drive the same
// binary that an installation runs, not a harness seam.

const REPO = join(import.meta.dirname, '..')
const READY_INTERVAL_MS = 250
const READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000

/** A child process that serves, its captured stderr, and the way to stop it. */
export type EnformProcess = {
  readonly child: ChildProcess
  readonly stderr: () => string
  readonly stop: () => Promise<void>
}

/** Run `node --experimental-strip-types cli/main.ts <args>` and wait for /readyz. */
export async function startEnform(
  args: readonly string[],
  publicUrl: string,
  timeoutMs: number = READY_TIMEOUT_MS
): Promise<EnformProcess> {
  const cli = join(REPO, 'cli', 'main.ts')
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  // Drain stdout so a chatty command cannot block on a full pipe.
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit'),
      delay(STOP_TIMEOUT_MS).then(() => {
        child.kill('SIGKILL')
      }),
    ])
  }

  const service: EnformProcess = { child, stderr: () => stderr, stop }
  try {
    await waitForReady(child, `${publicUrl}/readyz`, timeoutMs, () => stderr)
  } catch (error) {
    await stop()
    throw error
  }
  return service
}

async function waitForReady(
  child: ChildProcess,
  readyUrl: string,
  timeoutMs: number,
  stderr: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastFailure = 'no request was made'
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const how =
        child.signalCode !== null ? `signal ${child.signalCode}` : `code ${child.exitCode}`
      throw new Error(`enform exited with ${how} before ${readyUrl} answered:\n${stderr()}`)
    }
    try {
      const response = await fetch(readyUrl)
      if (response.ok) return
      lastFailure = `HTTP ${response.status}: ${await response.text()}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await delay(READY_INTERVAL_MS)
  }
  throw new Error(`${readyUrl} did not answer within ${timeoutMs} ms (${lastFailure})\n${stderr()}`)
}
