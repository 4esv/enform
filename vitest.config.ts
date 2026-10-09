import { defineConfig } from 'vitest/config'

// Three projects, so that `make invariants` and `make stories` run one suite
// each and `make check` runs all of them (MVP.md 11.4).
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
      { test: { name: 'stories', include: ['stories/**/*.test.ts'] } },
    ],
  },
})
