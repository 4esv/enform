import { defineConfig } from 'vitest/config'

// Four projects, so that `make invariants`, `make stories` and `make browser`
// run one suite each and `make check` runs all of them (MVP.md 11.4).
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
          exclude: ['node_modules/**', 'invariants/**', 'stories/**'],
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
    ],
  },
})
