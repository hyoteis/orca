import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Nightly code-intelligence budgets (#87): large fixtures + real clangd/
// basedpyright budgets, plus the mixed-version capability-contract suites that
// keep old-Host/old-Client pairs safe between releases (#28).
// Runs vitest's cli entry via node directly: spawning the pnpm shim fails on
// Windows (Node refuses .cmd without a shell) and this must run locally too.
const vitestCli = join(
  dirname(createRequire(`${import.meta.dirname}/../../package.json`).resolve('vitest/package.json')),
  'vitest.mjs'
)

function runVitest(config, suites = []) {
  const result = spawnSync(process.execPath, [vitestCli, 'run', '--config', config, ...suites], {
    stdio: 'inherit'
  })
  return result.status ?? 1
}

const nightlyStatus = runVitest('config/vitest.nightly.config.ts')
if (nightlyStatus !== 0) {
  process.exit(nightlyStatus)
}

// Mixed-version gate runs under the main config (the nightly config only
// includes tests/nightly).
process.exit(
  runVitest('config/vitest.config.ts', [
    'src/main/runtime/rpc/methods/language-server.test.ts',
    'src/main/runtime/rpc/streaming.test.ts',
    'src/main/ssh/ssh-relay-cross-version-isolation.test.ts'
  ])
)
