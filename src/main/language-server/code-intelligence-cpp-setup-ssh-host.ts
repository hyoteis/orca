import { posix } from 'node:path'
import type { Repo } from '../../shared/types'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { getCppScopeIdForRepo } from '../../shared/code-intelligence-scope'
import {
  installCppSetupTools,
  packageInstallCommands,
  type CppSetupToolName,
  type CppSetupToolPaths
} from './code-intelligence-cpp-setup-tools'
import { bundledGnCandidatePaths } from './code-intelligence-cpp-tool-provisioning'
import {
  SETUP_MANIFEST_FILE,
  parseCachedCodeIntelligenceSetupResult,
  remoteCppScopeDirectoryPath
} from './code-intelligence-setup-cache'
import {
  SshSetupConnectionError,
  SshSetupExecQueue,
  buildRemoteClangdDiscoveryCommand,
  buildRemoteFindIncludeDirectoriesCommand,
  buildRemoteFindSourceFilesCommand,
  buildRemoteGnDiscoveryCommand,
  buildRemoteMtimesCommand,
  buildRemoteReadableDirectoriesCommand,
  buildRemoteReadablePathCommand,
  buildRemoteReadFileCommand,
  buildRemoteToolLookupCommand,
  parseRemoteListing,
  sshBuildRootDetection,
  sshCommandRunner
} from './code-intelligence-ssh-setup-exec'
import type { CppSetupHost } from './code-intelligence-cpp-setup-host'

const DARWIN_CLANGD_CANDIDATES = ['/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd']

export type SshCppSetupHostDependencies = {
  getConnection: (targetId: string) => SshConnection | undefined
  getPlatform: (targetId: string) => RemoteOperatingSystem | undefined
}

async function discoverRemoteExecutable(
  queue: SshSetupExecQueue,
  command: string
): Promise<string | null> {
  const result = await queue.exec(command)
  if (result.code !== 0) {
    return null
  }
  const path = result.stdout.trim().split(/\r?\n/)[0]
  return path || null
}

/** Human-runnable variant of the install commands (interactive sudo, no -n). */
function manualInstallCommand(
  platform: NodeJS.Platform,
  missing: readonly CppSetupToolName[]
): string {
  return packageInstallCommands(platform, missing)
    .map((command) => command.filter((arg) => arg !== '-n').join(' '))
    .join(' && ')
}

export function createSshCppSetupHost(dependencies: SshCppSetupHostDependencies): CppSetupHost {
  // validateRepoHost resolves these before any other method may run.
  let queue: SshSetupExecQueue | undefined
  let platform: RemoteOperatingSystem | undefined
  let uname = ''
  const execQueue = (): SshSetupExecQueue => {
    if (!queue) {
      throw new Error('SSH setup host was used before validation')
    }
    return queue
  }
  return {
    get detection() {
      return sshBuildRootDetection(execQueue())
    },
    runCommand: (executable, args, cwd) =>
      sshCommandRunner(execQueue())(executable, args, cwd),
    validateRepoHost: async (repo: Repo, logs) => {
      const host = parseExecutionHostId(getRepoExecutionHostId(repo))
      if (host?.kind !== 'ssh') {
        return 'SSH C++ setup requires an SSH project'
      }
      const connection = dependencies.getConnection(host.targetId)
      if (!connection) {
        logs.push(`SSH target ${host.targetId} has no live connection`)
        return 'SSH Host is not connected. Reconnect and retry.'
      }
      const knownPlatform = dependencies.getPlatform(host.targetId)
      if (!knownPlatform) {
        logs.push(`SSH target ${host.targetId} is connected but its platform is not known yet`)
        return 'SSH Host is connected but its platform is not known yet. Reconnect the Host and retry.'
      }
      if (knownPlatform === 'win32') {
        return 'C++ setup on Windows SSH Hosts is not supported; POSIX Hosts (Linux, macOS, WSL) only.'
      }
      platform = knownPlatform
      queue = new SshSetupExecQueue(connection)
      return null
    },
    scopeDirectoryFor: async (repo: Repo) => {
      uname = await execQueue().capture('uname -s')
      if (!/^(Linux|Darwin)/.test(uname)) {
        throw new Error(`SSH Host is not a POSIX system (uname: ${uname || 'unknown'})`)
      }
      const home = await execQueue().capture('printf %s "$HOME"')
      if (!home || !posix.isAbsolute(home)) {
        throw new Error('Could not resolve the home directory on the SSH Host')
      }
      return remoteCppScopeDirectoryPath(home, getCppScopeIdForRepo(repo))
    },
    statMtimes: async (paths) => {
      const result = await execQueue().exec(buildRemoteMtimesCommand(paths, uname))
      if (result.code !== 0) {
        return null
      }
      const mtimes = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(Number)
      if (mtimes.length !== paths.length || mtimes.some((mtime) => !Number.isFinite(mtime))) {
        return null
      }
      return mtimes
    },
    readCachedResult: async (scopeDirectory, fingerprint) => {
      const manifest = await execQueue().exec(
        buildRemoteReadFileCommand(posix.join(scopeDirectory, SETUP_MANIFEST_FILE))
      )
      if (manifest.code !== 0) {
        return null
      }
      const cached = parseCachedCodeIntelligenceSetupResult(manifest.stdout, fingerprint)
      if (!cached) {
        return null
      }
      // Cache validation drops the local X_OK re-check: a moved clangd fails at spawn.
      const readable = await execQueue().exec(
        buildRemoteReadablePathCommand(posix.join(scopeDirectory, 'compile_commands.json'))
      )
      return readable.code === 0 ? cached : null
    },
    discoverTools: async (requiredTools, workspaceRoot) => {
      const tools: CppSetupToolPaths = {}
      for (const tool of requiredTools) {
        tools[tool] =
          (tool === 'clangd'
            ? await discoverRemoteExecutable(
                execQueue(),
                buildRemoteClangdDiscoveryCommand(DARWIN_CLANGD_CANDIDATES)
              )
            : tool === 'gn'
              ? await discoverRemoteExecutable(
                  execQueue(),
                  buildRemoteGnDiscoveryCommand(
                    bundledGnCandidatePaths(workspaceRoot, platform!, posix.join)
                  )
                )
              : await discoverRemoteExecutable(execQueue(), buildRemoteToolLookupCommand(tool))) ??
          undefined
      }
      return tools
    },
    installTools: async (missing, workspaceRoot, logs) => {
      try {
        return await installCppSetupTools({
          missing,
          platform: platform!,
          cwd: workspaceRoot,
          run: sshCommandRunner(execQueue()),
          logs
        })
      } catch (error) {
        if (error instanceof SshSetupConnectionError) {
          throw error
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}. Install manually on the SSH Host: ${manualInstallCommand(platform!, missing)}`
        )
      }
    },
    configureEnvironment: async () => undefined,
    ensureDirectory: async (directory) => {
      await execQueue().capture(`mkdir -p ${shellEscape(directory)}`)
    },
    resetBuildDirectory: async (buildDirectory) => {
      await execQueue().capture(
        `rm -rf ${shellEscape(buildDirectory)} && mkdir -p ${shellEscape(buildDirectory)}`
      )
    },
    findSourceFiles: async (root) =>
      parseRemoteListing(await execQueue().capture(buildRemoteFindSourceFilesCommand(root))),
    findIncludeDirectories: async (root) =>
      parseRemoteListing(await execQueue().capture(buildRemoteFindIncludeDirectoriesCommand(root))),
    readableDirectories: async (candidates) =>
      parseRemoteListing(await execQueue().capture(buildRemoteReadableDirectoriesCommand(candidates))),
    readTextFile: async (path) => await execQueue().capture(buildRemoteReadFileCommand(path)),
    writeTextFile: async (directory, fileName, content) => {
      await execQueue().writeFile(directory, fileName, content)
    },
    writeCachedResult: async (scopeDirectory, fingerprint, result) => {
      await execQueue().writeFile(
        scopeDirectory,
        SETUP_MANIFEST_FILE,
        JSON.stringify({ fingerprint, result }, null, 2)
      )
    },
    relativeGnOutput: (gnRoot, outputDirectory) => posix.relative(gnRoot, outputDirectory),
    describeRunError: (error, logs) => {
      if (error instanceof SshSetupConnectionError) {
        return 'SSH connection was interrupted. Reconnect and retry.'
      }
      logs.push(
        `\n## Error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      )
      return error instanceof Error ? error.message : String(error)
    }
  }
}
