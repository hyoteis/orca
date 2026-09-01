import { posix } from 'node:path'
import type { Store } from '../persistence'
import type { SshConnection } from '../ssh/ssh-connection'
import type { RemoteOperatingSystem } from '../ssh/ssh-remote-platform'
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
  NO_COMPILE_COMMANDS_MESSAGE,
  packageInstallCommands
} from './code-intelligence-cpp-setup-tools'
import { bundledGnCandidatePaths } from './code-intelligence-cpp-tool-provisioning'
import { mergeCompilationDatabaseShards } from './code-intelligence-compilation-database'
import { classifyCppBuildRoots } from './code-intelligence-build-root-classification'
import { remoteCppScopeDirectoryPath, SETUP_MANIFEST_FILE } from './code-intelligence-setup-cache'
import { readRemoteCachedSetupResult, remoteSetupFingerprint } from './code-intelligence-ssh-setup-cache'
import { generateRemoteCppShards } from './code-intelligence-ssh-shard-generation'
import {
  buildRemoteClangdDiscoveryCommand,
  buildRemoteGnDiscoveryCommand,
  buildRemoteToolLookupCommand,
  sshBuildRootDetection,
  sshCommandRunner,
  SshSetupConnectionError,
  SshSetupExecQueue
} from './code-intelligence-ssh-setup-exec'

const DARWIN_CLANGD_CANDIDATES = ['/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd']

type Dependencies = {
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
      if (!connection) {
        logs.push(`SSH target ${host.targetId} has no live connection`)
        return fail('SSH Host is not connected. Reconnect and retry.')
      }
      const platform = this.dependencies.getPlatform(host.targetId)
      if (!platform) {
        logs.push(`SSH target ${host.targetId} is connected but its platform is not known yet`)
        return fail(
          'SSH Host is connected but its platform is not known yet. Reconnect the Host and retry.'
        )
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
      const scopeDirectory = remoteCppScopeDirectoryPath(home, getCppScopeIdForRepo(repo))

      // Detection Promise.all degrades to serial through the exec queue (spec §4.2);
      // classification (coalescing, .gn upward search) probes the remote filesystem
      // through the same serial channel with the shared form-boundary rules.
      const detection = sshBuildRootDetection(queue)
      const { buildRoots, gnRootBySource, basicSourceRoots } = await classifyCppBuildRoots(
        workspaceRoot,
        roots,
        detection
      )

      const fingerprint = await remoteSetupFingerprint(queue, {
        repoId: repo.id,
        roots,
        request,
        buildRoots,
        uname
      })
      if (fingerprint) {
        const cached = await readRemoteCachedSetupResult(queue, scopeDirectory, fingerprint)
        if (cached) {
          return { ...cached, relativeRoots: roots }
        }
      }

      const requiredTools: CppSetupToolName[] = ['clangd']
      if (buildRoots.some((root) => root.system === 'cmake')) {
        requiredTools.push('cmake', 'ninja')
      }
      if ([...gnRootBySource.values()].some(Boolean)) {
        requiredTools.push('gn')
      }
      const discover = async (tool: CppSetupToolName): Promise<string | null> =>
        tool === 'clangd'
          ? await discoverRemoteExecutable(
              queue,
              buildRemoteClangdDiscoveryCommand(DARWIN_CLANGD_CANDIDATES)
            )
          : tool === 'gn'
            ? await discoverRemoteExecutable(
                queue,
                buildRemoteGnDiscoveryCommand(
                  bundledGnCandidatePaths(workspaceRoot, platform, posix.join)
                )
              )
            : await discoverRemoteExecutable(queue, buildRemoteToolLookupCommand(tool))
      const tools: Partial<Record<CppSetupToolName, string>> = {}
      for (const tool of requiredTools) {
        tools[tool] = (await discover(tool)) ?? undefined
      }
      const missing = requiredTools.filter((tool) => !tools[tool])
      if (missing.length > 0) {
        if (!request.installMissingTools) {
          return fail(`Missing tools: ${missing.join(', ')}`)
        }
        try {
          installedTools = await installCppSetupTools({
            missing,
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
            `${error instanceof Error ? error.message : String(error)}. Install manually on the SSH Host: ${manualInstallCommand(platform, missing)}`
          )
        }
        for (const tool of missing) {
          tools[tool] = (await discover(tool)) ?? undefined
          if (!tools[tool]) {
            return fail(`Installed tools were not found: ${tool}`)
          }
        }
      }

      const run = sshCommandRunner(queue)
      const { shards, generationModes } = await generateRemoteCppShards({
        queue,
        run,
        detection,
        workspaceRoot,
        scopeDirectory,
        request,
        buildRoots,
        gnRootBySource,
        basicSourceRoots,
        tools,
        logs
      })

      // Shards are read back and merged locally (single-source dedupe), the merged
      // CDB written back remotely.
      const merged = mergeCompilationDatabaseShards(shards)
      if (merged.length === 0) {
        return fail(NO_COMPILE_COMMANDS_MESSAGE)
      }
      await queue.writeFile(scopeDirectory, 'compile_commands.json', JSON.stringify(merged, null, 2))
      logs.push(`Merged ${merged.length} compile commands into ${scopeDirectory}`)

      const systems = [...generationModes].join(' + ')
      const configurationMode =
        generationModes.size === 1
          ? ([...generationModes][0].toLowerCase() as 'cmake' | 'gn' | 'basic')
          : 'mixed'
      const warnings = generationModes.has('BASIC')
        ? [
            'Basic indexing uses inferred include directories and may miss SDK headers, generated files, or build macros.'
          ]
        : []
      const result: CodeIntelligenceCppSetupResult = {
        ok: true,
        message: `Generated compile commands with ${systems}`,
        log: logs.join('\n').trim(),
        relativeRoots: roots,
        installedTools,
        clangdExecutable: tools.clangd,
        compileCommandsDir: scopeDirectory,
        configurationMode,
        healthState: warnings.length > 0 ? 'limited' : 'ready',
        compileCommandCount: merged.length,
        warnings
      }
      if (fingerprint) {
        // GN-reuse runs reach this point without any scope-directory mkdir of their own.
        await queue.capture(`mkdir -p ${shellEscape(scopeDirectory)}`)
        await queue.writeFile(
          scopeDirectory,
          SETUP_MANIFEST_FILE,
          JSON.stringify({ fingerprint, result }, null, 2)
        )
      }
      return result
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
