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
  appendCppSetupLog,
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
import { type CppBuildRootDetection } from './code-intelligence-cmake-root-selection'
import { classifyCppBuildRoots } from './code-intelligence-build-root-classification'
import { findGnOutputFile } from './code-intelligence-gn-output'
import { cppScopeDirectoryName } from './code-intelligence-setup-cache'
import {
  buildRemoteClangdDiscoveryCommand,
  buildRemoteFindIncludeDirectoriesCommand,
  buildRemoteFindSourceFilesCommand,
  buildRemoteListSubdirectoriesCommand,
  buildRemoteReadableDirectoriesCommand,
  buildRemoteReadablePathCommand,
  buildRemoteReadFileCommand,
  buildRemoteToolLookupCommand,
  SshSetupConnectionError,
  SshSetupExecQueue
} from './code-intelligence-ssh-setup-exec'

const DARWIN_CLANGD_CANDIDATES = ['/opt/homebrew/opt/llvm/bin/clangd', '/usr/local/opt/llvm/bin/clangd']

type Dependencies = {
  getConnection: (targetId: string) => SshConnection | undefined
  getPlatform: (targetId: string) => RemoteOperatingSystem | undefined
}

function sshBuildRootDetection(queue: SshSetupExecQueue): CppBuildRootDetection {
  return {
    join: posix.join,
    resolve: posix.resolve,
    relative: posix.relative,
    dirname: posix.dirname,
    isReadablePath: async (path) =>
      (await queue.exec(buildRemoteReadablePathCommand(path))).code === 0,
    listSubdirectories: async (directory) => {
      const result = await queue.exec(buildRemoteListSubdirectoriesCommand(directory))
      return result.code === 0 ? parseRemoteListing(result.stdout) : []
    }
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

function parseRemoteListing(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Reads a generated shard back for the local single-source merge;
 * mergeCompilationDatabaseShards validates the array shape. */
async function readRemoteShard(queue: SshSetupExecQueue, path: string): Promise<unknown[]> {
  return JSON.parse(await queue.capture(buildRemoteReadFileCommand(path))) as unknown[]
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

      // Detection Promise.all degrades to serial through the exec queue (spec §4.2);
      // classification (coalescing, .gn upward search) probes the remote filesystem
      // through the same serial channel with the shared form-boundary rules.
      const detection = sshBuildRootDetection(queue)
      const { buildRoots, gnRootBySource, basicSourceRoots } = await classifyCppBuildRoots(
        workspaceRoot,
        roots,
        detection
      )

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

      const scopeDirectory = posix.join(
        home,
        '.orca',
        'code-intelligence',
        'cpp',
        'scopes',
        cppScopeDirectoryName(getCppScopeIdForRepo(repo))
      )
      const shards: unknown[][] = []
      const generationModes = new Set<string>()

      if (basicSourceRoots.length > 0) {
        // Zero-source members keep the BASIC mode locally (empty shard semantics)
        // even when they contribute no commands of their own.
        generationModes.add('BASIC')
        const sourceFiles: string[] = []
        for (const sourceRoot of basicSourceRoots) {
          sourceFiles.push(
            ...parseRemoteListing(await queue.capture(buildRemoteFindSourceFilesCommand(sourceRoot)))
          )
        }
        if (sourceFiles.length > MAX_SOURCE_FILES) {
          return fail(`Basic C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
        }
        if (sourceFiles.length > 0) {
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
          const basicDirectory = posix.join(scopeDirectory, 'basic')
          await queue.capture(`mkdir -p ${shellEscape(basicDirectory)}`)
          await queue.writeFile(
            basicDirectory,
            'compile_commands.json',
            JSON.stringify(database, null, 2)
          )
          logs.push(
            `\n## Basic C++ indexing\nGenerated minimal commands for ${database.length} source files across: ${basicSourceRoots.join(', ')}`
          )
          shards.push(await readRemoteShard(queue, posix.join(basicDirectory, 'compile_commands.json')))
        }
      }

      const run = sshCommandRunner(queue)
      for (const [index, root] of buildRoots.entries()) {
        const buildDir = posix.join(scopeDirectory, `build-${index + 1}`)
        if (root.system === 'cmake') {
          await queue.capture(
            `rm -rf ${shellEscape(buildDir)} && mkdir -p ${shellEscape(buildDir)}`
          )
          const commandArgs = [
            '-S',
            root.sourceDir,
            '-B',
            buildDir,
            '-G',
            'Ninja',
            `-DCMAKE_MAKE_PROGRAM=${tools.ninja}`,
            '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
            '-DCMAKE_BUILD_TYPE=Debug'
          ]
          const result = await run(tools.cmake!, commandArgs, workspaceRoot)
          appendCppSetupLog(
            logs,
            `Configure ${root.memberLabel}`,
            [tools.cmake!, ...commandArgs],
            result
          )
          if (result.code !== 0) {
            throw new Error(`CMake configuration failed for ${root.memberLabel}`)
          }
          shards.push(await readRemoteShard(queue, posix.join(buildDir, 'compile_commands.json')))
          generationModes.add('CMAKE')
          continue
        }
        const gnRoot = gnRootBySource.get(root.sourceDir)
        if (!gnRoot) {
          continue
        }
        const existingCompileCommands = await findGnOutputFile(
          gnRoot,
          'compile_commands.json',
          detection
        )
        if (existingCompileCommands) {
          logs.push(`\n## Reuse GN compile commands\n${existingCompileCommands}`)
          shards.push(await readRemoteShard(queue, existingCompileCommands))
          generationModes.add('GN')
          continue
        }
        const existingArgsFile = await findGnOutputFile(gnRoot, 'args.gn', detection)
        const generatedOutputDir = existingArgsFile
          ? posix.dirname(existingArgsFile)
          : posix.join(
              gnRoot,
              'out',
              `.orca-code-intelligence-${posix.basename(posix.dirname(buildDir))}-${posix.basename(buildDir)}`
            )
        const relativeOutputDir = posix.relative(gnRoot, generatedOutputDir)
        if (!relativeOutputDir || relativeOutputDir.startsWith('../')) {
          throw new Error('GN output directory resolved outside the project root')
        }
        const commandArgs = ['gen', relativeOutputDir, `--root=${gnRoot}`, '--export-compile-commands']
        const result = await run(tools.gn!, commandArgs, gnRoot)
        appendCppSetupLog(
          logs,
          `Configure ${root.memberLabel}`,
          [tools.gn!, ...commandArgs],
          result
        )
        if (result.code !== 0) {
          throw new Error(
            `GN generation failed for ${root.memberLabel}. Generate a GN output directory with the project's required args.gn, then retry.`
          )
        }
        shards.push(
          await readRemoteShard(queue, posix.join(generatedOutputDir, 'compile_commands.json'))
        )
        generationModes.add('GN')
      }

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
      return {
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
