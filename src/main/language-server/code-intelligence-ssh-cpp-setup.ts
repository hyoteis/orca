import { posix } from 'node:path'
import type { Store } from '../persistence'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
import { buildPosixLanguageServerCommand } from '../ssh/ssh-language-server-session-manager'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { getCppScopeIdForRepo, normalizeScopeMemberPath } from '../../shared/code-intelligence-scope'
import { shellEscape } from '../ssh/ssh-connection-utils'
import {
  type CppSetupToolName,
  installCppSetupTools,
  MAX_LOG_BYTES,
  NO_COMPILE_COMMANDS_MESSAGE,
  packageInstallCommands,
  type CppSetupCommandRunner
} from './code-intelligence-cpp-setup-tools'
import {
  compilerArguments,
  MAX_SOURCE_FILES,
  mergeCompilationDatabaseShards
} from './code-intelligence-compilation-database'
import {
  type CppBuildRoot,
  type CppBuildRootDetection,
  detectCppBuildRoot
} from './code-intelligence-cmake-root-selection'
import { cppScopeDirectoryName } from './code-intelligence-setup-cache'
import {
  buildRemoteClangdDiscoveryCommand,
  buildRemoteFindIncludeDirectoriesCommand,
  buildRemoteFindSourceFilesCommand,
  buildRemoteReadableDirectoriesCommand,
  SshSetupConnectionError,
  SshSetupExecQueue
} from './code-intelligence-ssh-setup-exec'

const MISSING_CLANGD = ['clangd'] as const satisfies readonly CppSetupToolName[]
const DARWIN_CLANGD_CANDIDATES = ['/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd']

type Dependencies = {
  getConnection: (targetId: string) => SshConnection | undefined
  getPlatform: (targetId: string) => RemoteOperatingSystem | undefined
}

function sshBuildRootDetection(queue: SshSetupExecQueue): CppBuildRootDetection {
  return {
    join: posix.join,
    resolve: posix.resolve,
    isReadablePath: async (path) =>
      (await queue.exec(`test -r ${shellEscape(path)}`)).code === 0
  }
}

/** CppSetupCommandRunner over SSH; `env` is ignored (spec §4.2: no MSVC capture remotely). */
function sshCommandRunner(queue: SshSetupExecQueue): CppSetupCommandRunner {
  return async (executable, args, cwd) => {
    const result = await queue.exec(buildPosixLanguageServerCommand({ executable, args, cwd }))
    if (result.code === null) {
      // Channel died mid-command: not an install failure, a disconnect.
      throw new SshSetupConnectionError('SSH connection was interrupted')
    }
    const output = `${result.stdout}${result.stderr}`.slice(0, MAX_LOG_BYTES)
    return { code: result.code, output }
  }
}

async function discoverRemoteClangd(queue: SshSetupExecQueue): Promise<string | null> {
  const result = await queue.exec(buildRemoteClangdDiscoveryCommand(DARWIN_CLANGD_CANDIDATES))
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

function parseRemoteListing(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export class CodeIntelligenceSshCppSetup {
  constructor(
    private readonly store: Store,
    private readonly dependencies: Dependencies
  ) {}

  async run(request: CodeIntelligenceCppSetupRequest): Promise<CodeIntelligenceCppSetupResult> {
    const logs: string[] = []
    let roots: string[] = []
    let installedTools: string[] = []
    const fail = (message: string): CodeIntelligenceCppSetupResult => ({
      ok: false,
      message,
      log: logs.join('\n').trim(),
      relativeRoots: roots,
      installedTools
    })
    try {
      const repo = this.store.getRepo(request.repoId)
      if (!repo) {
        return fail('Project is no longer available')
      }
      const host = parseExecutionHostId(getRepoExecutionHostId(repo))
      if (host?.kind !== 'ssh') {
        return fail('SSH C++ setup requires an SSH project')
      }
      const connection = this.dependencies.getConnection(host.targetId)
      const platform = this.dependencies.getPlatform(host.targetId)
      if (!connection || !platform) {
        return fail('SSH Host is not connected. Reconnect and retry.')
      }
      if (platform === 'win32') {
        return fail(
          'C++ setup on Windows SSH Hosts is not supported; POSIX Hosts (Linux, macOS, WSL) only.'
        )
      }
      // Dual-form members: workspace-relative and host-absolute strings coexist.
      roots = [...new Set(request.relativeRoots.map(normalizeScopeMemberPath))]
      if (roots.length === 0) {
        return fail('Select at least one C++ build directory')
      }
      const workspaceRoot = posix.resolve(repo.path)
      const queue = new SshSetupExecQueue(connection)

      const uname = await queue.capture('uname -s')
      if (!/^(Linux|Darwin)/.test(uname)) {
        return fail(`SSH Host is not a POSIX system (uname: ${uname || 'unknown'})`)
      }
      const home = await queue.capture('printf %s "$HOME"')
      if (!home || !posix.isAbsolute(home)) {
        return fail('Could not resolve the home directory on the SSH Host')
      }

      // Detection Promise.all degrades to serial through the exec queue (spec §4.2).
      const buildRoots: CppBuildRoot[] = await Promise.all(
        roots.map((root) => detectCppBuildRoot(workspaceRoot, root, sshBuildRootDetection(queue)))
      )
      const unsupported = buildRoots.filter((root) => root.system !== 'basic')
      if (unsupported.length > 0) {
        return fail(
          `SSH C++ setup currently covers plain source folders; CMake/GN members on SSH Hosts arrive in a later update: ${unsupported
            .map((root) => root.memberLabel)
            .join(', ')}`
        )
      }

      let clangd = await discoverRemoteClangd(queue)
      if (!clangd) {
        if (!request.installMissingTools) {
          return fail(`Missing tools: clangd`)
        }
        try {
          installedTools = await installCppSetupTools({
            missing: MISSING_CLANGD,
            platform,
            cwd: workspaceRoot,
            run: sshCommandRunner(queue),
            logs
          })
        } catch (error) {
          if (error instanceof SshSetupConnectionError) {
            throw error
          }
          return fail(
            `${error instanceof Error ? error.message : String(error)}. Install manually on the SSH Host: ${manualInstallCommand(platform, MISSING_CLANGD)}`
          )
        }
        clangd = await discoverRemoteClangd(queue)
        if (!clangd) {
          return fail('Installed tools were not found: clangd')
        }
      }

      const sourceFiles: string[] = []
      for (const root of buildRoots) {
        sourceFiles.push(
          ...parseRemoteListing(await queue.capture(buildRemoteFindSourceFilesCommand(root.sourceDir)))
        )
      }
      if (sourceFiles.length === 0) {
        return fail(NO_COMPILE_COMMANDS_MESSAGE)
      }
      if (sourceFiles.length > MAX_SOURCE_FILES) {
        return fail(`Basic C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
      }

      const discoveredIncludes: string[] = []
      for (const discoveryRoot of new Set([workspaceRoot, ...buildRoots.map((r) => r.sourceDir)])) {
        discoveredIncludes.push(
          ...parseRemoteListing(
            await queue.capture(buildRemoteFindIncludeDirectoriesCommand(discoveryRoot))
          )
        )
      }
      const additionalIncludes = (request.additionalIncludeDirectories ?? []).map((path) =>
        posix.isAbsolute(path) ? posix.resolve(path) : posix.resolve(workspaceRoot, path)
      )
      const includeCandidates = [
        workspaceRoot,
        ...additionalIncludes,
        ...discoveredIncludes,
        ...buildRoots.flatMap((root) => [
          root.sourceDir,
          posix.join(root.sourceDir, 'api'),
          posix.join(root.sourceDir, 'include'),
          posix.join(root.sourceDir, 'src')
        ])
      ]
      const includeDirectories = parseRemoteListing(
        await queue.capture(buildRemoteReadableDirectoriesCommand([...new Set(includeCandidates)]))
      )

      const defines = (request.defines ?? []).map((define) => define.trim()).filter(Boolean)
      const database = sourceFiles.map((file) => ({
        directory: workspaceRoot,
        file,
        arguments: compilerArguments(file, includeDirectories, defines, request.cppStandard ?? 'c++17')
      }))
      const scopeDirectory = posix.join(
        home,
        '.orca',
        'code-intelligence',
        'cpp',
        'scopes',
        cppScopeDirectoryName(getCppScopeIdForRepo(repo))
      )
      const basicDirectory = posix.join(scopeDirectory, 'basic')
      await queue.capture(`mkdir -p ${shellEscape(basicDirectory)}`)
      await queue.writeFile(basicDirectory, 'compile_commands.json', JSON.stringify(database, null, 2))
      logs.push(
        `\n## Basic C++ indexing\nGenerated minimal commands for ${database.length} source files across: ${buildRoots
          .map((root) => root.memberLabel)
          .join(', ')}`
      )

      // Shard is read back and merged locally (single-source dedupe), result written remotely.
      const shard = JSON.parse(
        await queue.capture(`cat ${shellEscape(posix.join(basicDirectory, 'compile_commands.json'))}`)
      )
      const merged = mergeCompilationDatabaseShards([shard])
      await queue.writeFile(scopeDirectory, 'compile_commands.json', JSON.stringify(merged, null, 2))
      logs.push(`Merged ${merged.length} compile commands into ${scopeDirectory}`)

      return {
        ok: true,
        message: 'Generated compile commands with BASIC',
        log: logs.join('\n').trim(),
        relativeRoots: roots,
        installedTools,
        clangdExecutable: clangd,
        compileCommandsDir: scopeDirectory,
        configurationMode: 'basic',
        healthState: 'limited',
        compileCommandCount: merged.length,
        warnings: [
          'Basic indexing uses inferred include directories and may miss SDK headers, generated files, or build macros.'
        ]
      }
    } catch (error) {
      if (error instanceof SshSetupConnectionError) {
        return fail('SSH connection was interrupted. Reconnect and retry.')
      }
      logs.push(
        `\n## Error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      )
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
}
