import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Nightly-only project: large fixtures and real language-server processes.
// Deliberately outside config/vitest.config.ts so PR runs never pay for it.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/nightly/**/*.test.ts'],
    // Why: fixture generation alone writes 100k+ files; server startups and
    // teardown waits sit far above the PR-suite ceilings.
    hookTimeout: 900_000,
    testTimeout: 600_000,
    // One worker: fixtures share a temp root and budgets measure cold costs.
    maxWorkers: 1,
    minWorkers: 1
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  }
})
