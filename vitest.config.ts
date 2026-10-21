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
          exclude: ['node_modules/**', 'invariants/**', 'stories/**', 'integration/**'],
        },
      },
      { test: { name: 'invariants', include: ['invariants/**/*.test.ts'] } },
      {
        test: {
          name: 'stories',
          include: ['stories/**/*.test.ts'],
          exclude: ['stories/**/gui.test.ts'],
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
