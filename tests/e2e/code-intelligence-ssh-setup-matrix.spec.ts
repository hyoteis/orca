import { spawnSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDisconnectedDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'

// #87 SSH release-route matrix for C++ setup (#33 close-out): real docker POSIX
// host, 100 ms netem RTT, disconnect-mid-setup idempotent rerun, low-disk quota.
const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

const LOW_DISK_FILE_COUNT = 400 // merged CDB ≈ 200 KB, far over the 100 KB quota

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Writes `count` stub TUs inside the seeded relay repo with one container-side
 * node loop — per-file docker execs would dominate the run time. */
function seedCppSources(target: DockerSshRelayTarget, count: number): void {
  const script = [
    `const fs = require('node:fs')`,
    `const root = ${shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)}`,
    `fs.mkdirSync(root + '/src', { recursive: true })`,
    `fs.mkdirSync(root + '/include', { recursive: true })`,
    `fs.writeFileSync(root + '/include/nightly-helper.h', 'inline int nightly_helper(void) { return 42; }\\n')`,
    `for (let i = 0; i < ${count}; i++) {`,
    `  fs.writeFileSync(root + '/src/tu-' + i + '.cpp', '#include "nightly-helper.h"\\nint tu_' + i + '(void) { return nightly_helper(); }\\n')`,
    `}`
  ].join(';')
  execDockerSshRelayTargetCommand(
    target,
    `node -e ${shellQuote(script)} && find ${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}/src -name '*.cpp' | wc -l`
  )
}

function readRemoteCdbEntryCount(target: DockerSshRelayTarget): number {
  const output = execDockerSshRelayTargetCommand(
    target,
    `node -e ${shellQuote(
      [
        `const fs = require('node:fs')`,
        `const scopes = '/root/.orca/code-intelligence/cpp/scopes'`,
        `const dirs = fs.readdirSync(scopes)`,
        `if (dirs.length !== 1) throw new Error('expected one scope dir, got ' + dirs.join(','))`,
        `console.log(String(JSON.parse(fs.readFileSync(scopes + '/' + dirs[0] + '/compile_commands.json', 'utf8')).length))`
      ].join(';')
    )}`
  )
  const count = Number(output.trim().split(/\r?\n/).at(-1))
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`remote merged CDB count was not readable: ${output}`)
  }
  return count
}

type SetupResult = {
  ok: boolean
  message: string
  log: string
  relativeRoots: string[]
  installedTools: string[]
  clangdExecutable?: string
  compileCommandsDir?: string
  configurationMode?: string
  healthState?: string
  compileCommandCount?: number
  warnings?: string[]
}

async function runSetup(page: Page, repoId: string): Promise<SetupResult> {
  const result = (await page.evaluate(
    (setupRepoId) =>
      window.api.codeIntelligence.setupCpp({
        repoId: setupRepoId,
        relativeRoots: ['.'],
        installMissingTools: true
      }),
    repoId
  )) as SetupResult
  console.log(
    `[ci-ssh-matrix] setup ok=${result.ok} mode=${result.configurationMode} count=${result.compileCommandCount} message=${result.message}`
  )
  return result
}

/** The platform probe can land just after connect; one bounded retry rides it out. */
async function runSetupWithPlatformRetry(page: Page, repoId: string): Promise<SetupResult> {
  let result = await runSetup(page, repoId)
  for (
    let attempt = 0;
    attempt < 3 && result.message.includes('platform is not known');
    attempt++
  ) {
    await page.waitForTimeout(3_000)
    result = await runSetup(page, repoId)
  }
  return result
}

function setDockerSshNetem(target: DockerSshRelayTarget, action: 'add' | 'del'): void {
  const qdisc =
    action === 'add'
      ? 'tc qdisc add dev eth0 root netem delay 100ms'
      : 'tc qdisc del dev eth0 root'
  execDockerSshRelayTargetCommand(target, `${qdisc} 2>/dev/null || true`)
}

async function stopContainer(target: DockerSshRelayTarget): Promise<void> {
  spawnSync('docker', ['stop', '-t', '1', target.containerName], {
    stdio: 'ignore',
    timeout: 30_000
  })
}

/** docker start + poll until sshd actually LISTENS — `docker exec` succeeds
 * before the port is bound, and an early reconnect gets ECONNREFUSED. */
async function startContainerAndWaitForSsh(target: DockerSshRelayTarget): Promise<void> {
  spawnSync('docker', ['start', target.containerName], { stdio: 'ignore', timeout: 60_000 })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const probe = spawnSync(
      'ssh',
      [
        '-i',
        target.identityFile,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-p',
        String(target.port),
        `root@${target.host}`,
        'true'
      ],
      { stdio: 'ignore', timeout: 10_000 }
    )
    if (probe.status === 0) {
      return
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, 1_000))
  }
  throw new Error(`container did not come back: ${target.containerName}`)
}

function remoteMergedCdbExists(target: DockerSshRelayTarget): boolean {
  const output = execDockerSshRelayTargetCommand(
    target,
    `node -e ${shellQuote(
      [
        `const fs = require('node:fs')`,
        `const scopes = '/root/.orca/code-intelligence/cpp/scopes'`,
        `console.log(fs.existsSync(scopes) && fs.readdirSync(scopes).some((dir) => fs.existsSync(scopes + '/' + dir + '/compile_commands.json')) ? 'yes' : 'no')`
      ].join(';')
    )}`
  )
  return output.trim().endsWith('yes')
}

test.describe('C++ code intelligence SSH setup matrix', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH C++ setup matrix.')
  test.skip(process.platform === 'win32', 'Docker SSH matrix uses POSIX ssh tooling.')

  test('generates the merged remote CDB on a real POSIX host', async ({ orcaPage }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      seedCppSources(target, 6)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const connected = await connectDockerSshRelayTarget(orcaPage, target)
      const result = await runSetupWithPlatformRetry(orcaPage, connected.repoId)
      expect(result.ok).toBe(true)
      expect(result.configurationMode).toBe('basic')
      expect(result.clangdExecutable).toBeTruthy()
      expect(result.compileCommandCount).toBe(6)
      expect(readRemoteCdbEntryCount(target)).toBe(6)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('succeeds under a 100 ms netem RTT link', async ({ orcaPage }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, {
        dockerRunArgs: ['--cap-add=NET_ADMIN']
      })
      seedCppSources(target, 6)
      setDockerSshNetem(target, 'add')
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const connected = await connectDockerSshRelayTarget(orcaPage, target)
      const startedAt = Date.now()
      const result = await runSetupWithPlatformRetry(orcaPage, connected.repoId)
      testInfo.annotations.push({
        type: 'ci-ssh-setup-rtt',
        description: `100ms netem setup elapsed=${Date.now() - startedAt}ms`
      })
      expect(result.ok).toBe(true)
      expect(result.compileCommandCount).toBe(6)
      expect(readRemoteCdbEntryCount(target)).toBe(6)
    } finally {
      if (target) {
        setDockerSshNetem(target, 'del')
      }
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('fails cleanly when the connection drops mid-setup and reruns idempotently', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, {
        dockerRunArgs: ['--cap-add=NET_ADMIN']
      })
      // netem stretches the setup's serial exec queue so the stop lands mid-run.
      seedCppSources(target, 60)
      setDockerSshNetem(target, 'add')
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const connected = await connectDockerSshRelayTarget(orcaPage, target)

      const interrupted = runSetup(orcaPage, connected.repoId)
      await orcaPage.waitForTimeout(3_000)
      await stopContainer(target)
      const failed = await interrupted
      expect(failed.ok).toBe(false)
      expect(failed.message).toContain('interrupted')

      await startContainerAndWaitForSsh(target)
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, connected.targetId)
      const rerun = await runSetupWithPlatformRetry(orcaPage, connected.repoId)
      expect(rerun.ok).toBe(true)
      expect(readRemoteCdbEntryCount(target)).toBe(60)
    } finally {
      if (target) {
        setDockerSshNetem(target, 'del')
      }
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('fails atomically when ~/.orca runs out of disk', async ({ orcaPage }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, {
        // 100 KB quota vs a ~200 KB merged CDB: the write must hit ENOSPC.
        dockerRunArgs: ['--tmpfs', '/root/.orca:size=100k,uid=0,gid=0']
      })
      seedCppSources(target, LOW_DISK_FILE_COUNT)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const connected = await connectDockerSshRelayTarget(orcaPage, target)
      const result = await runSetupWithPlatformRetry(orcaPage, connected.repoId)
      expect(result.ok).toBe(false)
      expect(result.message.length).toBeGreaterThan(0)
      expect(result.log).toContain('Error')
      // Atomic failure: the ENOSPC write must leave no torn merged CDB behind.
      expect(remoteMergedCdbExists(target)).toBe(false)
      testInfo.annotations.push({
        type: 'ci-ssh-setup-low-disk',
        description: result.message
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
