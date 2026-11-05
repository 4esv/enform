import { defineConfig } from 'vitest/config'

// Five projects, so that `make invariants`, `make stories` and `make browser`
// run one suite each and `make check` runs all of them (MVP.md 11.4). The
// integration project runs on its own, against the Compose stack, because the
// unit project would otherwise pick up `integration/**`.
//
// The browser suite is a project of its own because driving Chromium (`gui`
// mode, #27) starves the other suites when it runs beside them: on a cold
// machine the five-second budget of an unrelated test is gone before the test
// starts. It runs after them, on its own, with a longer budget.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.test.ts'],
          // A linked worktree under .claude/ or a nested node_modules is not this
          // checkout's suite (AGENTS.md: a delegated lane works in its own tree).
          exclude: [
            '**/node_modules/**',
            '**/.claude/**',
            'invariants/**',
            'stories/**',
            'integration/**',
          ],
        },
      },
      { test: { name: 'invariants', include: ['invariants/**/*.test.ts'] } },
      {
        test: {
          name: 'stories',
          include: ['stories/**/*.test.ts'],
          exclude: ['stories/**/gui.test.ts'],
          // An operator suite runs every variant of a golden path through the
          // harness API, and the Actor operator alone runs one api run per
          // person and step; under the load of the whole check that exceeds
          // the five-second default, so the project allows what the
          // operator suites that set their own timeout already allow.
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: 'browser',
          include: ['stories/**/gui.test.ts'],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
