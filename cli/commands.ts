// Issue #38, S01, DF-1, DF-4, DX-3, I9: the `enform` command, unit 1. This is
// the scaffold commit: the `flow` file commands are not implemented yet, so
// every command exits 1. The next commit implements `init`, `validate` and
// `pull`. The CLI is file-backed and in-process and holds no correctness logic
// (A9).

/**
 * Run one `enform` command line and return its exit code. No command is
 * implemented in this commit, so the entry point reports the pending work and
 * fails; the CLI test is marked expected to fail for #38.
 */
export function main(argv: readonly string[]): number {
  process.stderr.write(`enform: not implemented yet: ${argv.join(' ')}\n`)
  return 1
}
