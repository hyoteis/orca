import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// #87: C++ SSH setup release-route matrix on the docker SSH relay fixture.
// Runs node entry points directly: spawning the pnpm shim fails on Windows
// (Node refuses .cmd without a shell) and this runner must work locally too.
const requireFromRepo = createRequire(`${import.meta.dirname}/../../package.json`)
const electronRuntimeScript = join(import.meta.dirname, 'ensure-native-runtime.mjs')
const playwrightCli = join(
  dirname(requireFromRepo.resolve('playwright/package.json')),
  'cli.js'
)

const extraArgs = process.argv.slice(2)
const env = {
  ...process.env,
  ORCA_E2E_SSH_DOCKER: '1'
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  return result.status ?? 1
}

const runtimeStatus = run(process.execPath, [electronRuntimeScript, '--runtime=electron'])
if (runtimeStatus !== 0) {
  process.exit(runtimeStatus)
}

process.exit(
  run(process.execPath, [
    playwrightCli,
    'test',
    'tests/e2e/code-intelligence-ssh-setup-matrix.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...extraArgs
  ])
)
