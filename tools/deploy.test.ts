import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { main } from '../cli/commands.js'

// Issue #213, DE-2, DE-3, ADR 0011: the one `enform` executable and the
// service artifacts that a template installation ships. The binary has only
// the `flow` group today and the service artifacts do not exist yet, so both
// checks are expected to fail until the implementation lane lands (MVP.md
// 11.1). They read files and call the command in-process: no database and no
// network.

const repo = join(import.meta.dirname, '..')

/** Run the command line and return its status and the text it wrote to stdout. */
function capturedStdout(argv: readonly string[]): { status: number; text: string } {
  const chunks: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    return { status: main(argv), text: chunks.join('') }
  } finally {
    write.mockRestore()
  }
}

test('DE-2 the enform binary exposes serve, worker, migrate, admin, seed, doctor and version', () => {
  const version = capturedStdout(['version'])
  expect(version.status, version.text).toBe(0)
  expect(version.text, 'the version names enform').toMatch(/\benform\b/i)
  expect(version.text, 'the version names a version number').toMatch(/\b\d+\.\d+\.\d+\b/)

  const help = capturedStdout(['help'])
  expect(help.status, help.text).toBe(0)
  for (const command of ['serve', 'worker', 'migrate', 'admin', 'seed', 'doctor', 'version']) {
    expect(help.text, `${command} is listed`).toMatch(new RegExp(`\\b${command}\\b`))
  }
})

test('DE-3 the repository ships a systemd unit and a container image with the service surface', () => {
  const unit = readFileSync(join(repo, 'deploy', 'systemd', 'enform.service'), 'utf8')
  expect(unit, 'the unit runs enform serve').toMatch(/^ExecStart=.*\benform(?:\.exe)?\s+serve\b/m)
  expect(unit, 'the unit runs as an unprivileged user').toMatch(/^User=enform$/m)
  expect(unit, 'the unit restarts on failure').toMatch(/^Restart=on-failure$/m)
  expect(unit, 'the unit stops on SIGTERM').toMatch(/^StopSignal=SIGTERM$/m)
  expect(unit, 'the unit reads its configuration under /etc/enform').toMatch(
    /\/etc\/enform\/[\w.-]+/
  )

  const dockerfile = readFileSync(join(repo, 'deploy', 'Dockerfile'), 'utf8')
  expect(dockerfile, 'the image exposes the HTTP port').toMatch(/^EXPOSE\s+8080\b/m)
  const user = dockerfile.match(/^USER\s+(\S+)\s*$/m)?.[1]
  expect(user, 'the image runs as a non-root user').toBeDefined()
  expect(user, 'the image does not run as root').not.toMatch(/^(root|0)$/)
})
