import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { Store } from '../persistence'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getCppScopeIdForRepo, normalizeScopeMemberPath } from '../../shared/code-intelligence-scope'
import {
  appendCppSetupLog,
  NO_COMPILE_COMMANDS_MESSAGE,
  resolveCppSetupEnvironment,
  runCppSetupCommand,
  type CppSetupCommandRunner,
  type CppSetupToolName,
  type CppSetupToolPaths
} from './code-intelligence-cpp-setup-tools'
import {
  createBasicCompilationDatabase,
  mergeCompilationDatabases
} from './code-intelligence-compilation-database'
import { type CppBuildRoot } from './code-intelligence-cmake-root-selection'
import { findGnOutputFile } from './code-intelligence-gn-output'
import { classifyCppBuildRoots } from './code-intelligence-build-root-classification'
import { provisionCppSetupTools } from './code-intelligence-cpp-tool-provisioning'
import {
  cppScopeDirectoryPath,
  createCodeIntelligenceSetupFingerprint,
  readCachedCodeIntelligenceSetupResult,
  writeCachedCodeIntelligenceSetupResult
} from './code-intelligence-setup-cache'

type SetupDependencies = {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  run?: CppSetupCommandRunner
}
export class CodeIntelligenceCppSetup {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly arch: string
  private readonly runCommand: CppSetupCommandRunner

  constructor(
    private readonly store: Store,
    private readonly cacheRoot: string,
    dependencies: SetupDependencies = {}
  ) {
    this.platform = dependencies.platform ?? process.platform
    this.arch = dependencies.arch ?? process.arch
    this.env = dependencies.env ?? process.env
    this.runCommand = dependencies.run ?? runCppSetupCommand
  }

  async run(request: CodeIntelligenceCppSetupRequest): Promise<CodeIntelligenceCppSetupResult> {
    const logs: string[] = []
    const fail = (message: string, roots: string[], installedTools: string[] = []) => ({
      ok: false,
      message,
      log: logs.join('\n').trim(),
      relativeRoots: roots,
      installedTools
    })
    let roots: string[] = []
    let installedTools: string[] = []
    try {
      const repo = this.store.getRepo(request.repoId)
      if (!repo) {
        return fail('Project is no longer available', roots)
      }
      if (getRepoExecutionHostId(repo) !== 'local') {
        return fail('One-click C++ setup currently requires a local Host', roots)
      }
      // Dual-form members: workspace-relative and host-absolute strings coexist.
      roots = [...new Set(request.relativeRoots.map(normalizeScopeMemberPath))]
      if (roots.length === 0) {
        return fail('Select at least one C++ build directory', roots)
      }
      const workspaceRoot = resolve(repo.path)
      const { buildRoots, gnRootBySource, basicSourceRoots } = await classifyCppBuildRoots(
        workspaceRoot,
        roots
      )
      const fingerprint = await createCodeIntelligenceSetupFingerprint({
        repoId: repo.id,
        roots,
        request,
        buildRoots
      })
      const outputRoot = cppScopeDirectoryPath(this.cacheRoot, getCppScopeIdForRepo(repo))
      const cachedResult = await readCachedCodeIntelligenceSetupResult(outputRoot, fingerprint)
      if (cachedResult) {
        return { ...cachedResult, relativeRoots: roots }
      }
      const requiredTools = new Set<CppSetupToolName>(['clangd'])
      if (buildRoots.some((root) => root.system === 'cmake')) {
        requiredTools.add('cmake')
        requiredTools.add('ninja')
      }
      if ([...gnRootBySource.values()].some(Boolean)) {
        requiredTools.add('gn')
      }
      const { tools, installedTools: provisionedTools } = await provisionCppSetupTools({
        requiredTools,
        installMissingTools: request.installMissingTools,
        platform: this.platform,
        arch: this.arch,
        env: this.env,
        cacheRoot: this.cacheRoot,
        workspaceRoot,
        run: this.runCommand,
        logs
      })
      installedTools = provisionedTools
      const commandEnvironment = buildRoots.some((root) => root.system === 'cmake')
        ? await resolveCppSetupEnvironment(this.platform, this.env, logs)
        : this.env
      await mkdir(outputRoot, { recursive: true })
      const compileCommandFiles: string[] = []
      const generationModes = new Set<string>()
      if (basicSourceRoots.length > 0) {
        const basicDatabase = await createBasicCompilationDatabase({
          workspaceRoot,
          sourceRoots: basicSourceRoots,
          includeDiscoveryRoots: buildRoots.map((root) => root.sourceDir),
          outputDirectory: join(outputRoot, 'basic'),
          additionalIncludeDirectories: request.additionalIncludeDirectories,
          defines: request.defines,
          cppStandard: request.cppStandard
        })
        compileCommandFiles.push(basicDatabase.filePath)
        generationModes.add('BASIC')
        logs.push(
          `\n## Basic C++ indexing\nNo GN dotfile was found; generated minimal commands for ${basicDatabase.sourceFileCount} source files across: ${basicSourceRoots.join(', ')}`
        )
      }
      for (const [index, root] of buildRoots.entries()) {
        if (root.system === 'cmake') {
          compileCommandFiles.push(
            await this.configureCmakeRoot(
              root,
              join(outputRoot, `build-${index + 1}`),
              workspaceRoot,
              tools,
              commandEnvironment,
              logs
            )
          )
          generationModes.add('CMAKE')
          continue
        }
        const gnRoot = gnRootBySource.get(root.sourceDir)
        if (!gnRoot) {
          continue
        }
        compileCommandFiles.push(
          await this.configureGnRoot(
            root,
            join(outputRoot, `build-${index + 1}`),
            gnRoot,
            tools.gn!,
            commandEnvironment,
            logs
          )
        )
        generationModes.add('GN')
      }
      const compileCommandCount = await mergeCompilationDatabases(compileCommandFiles, outputRoot)
      if (compileCommandCount === 0) {
        return fail(
          NO_COMPILE_COMMANDS_MESSAGE,
          roots,
          installedTools
        )
      }
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
        compileCommandsDir: outputRoot,
        configurationMode,
        healthState: warnings.length > 0 ? 'limited' : 'ready',
        compileCommandCount,
        warnings
      }
      await writeCachedCodeIntelligenceSetupResult(outputRoot, fingerprint, result)
      return result
    } catch (error) {
      logs.push(
        `\n## Error\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      )
      return fail(error instanceof Error ? error.message : String(error), roots, installedTools)
    }
  }

  private async configureCmakeRoot(
    root: CppBuildRoot,
    buildDir: string,
    workspaceRoot: string,
    tools: CppSetupToolPaths,
    environment: NodeJS.ProcessEnv,
    logs: string[]
  ): Promise<string> {
    await rm(buildDir, { recursive: true, force: true })
    await mkdir(buildDir, { recursive: true })
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
    const result = await this.runCommand(tools.cmake!, commandArgs, workspaceRoot, environment)
    appendCppSetupLog(
      logs,
      `Configure ${root.memberLabel}`,
      [tools.cmake!, ...commandArgs],
      result
    )
    if (result.code !== 0) {
      throw new Error(`CMake configuration failed for ${root.memberLabel}`)
    }
    return join(buildDir, 'compile_commands.json')
  }

  private async configureGnRoot(
    root: CppBuildRoot,
    buildDir: string,
    gnRoot: string,
    gnExecutable: string,
    environment: NodeJS.ProcessEnv,
    logs: string[]
  ): Promise<string> {
    const existingCompileCommands = await findGnOutputFile(gnRoot, 'compile_commands.json')
    if (existingCompileCommands) {
      logs.push(`\n## Reuse GN compile commands\n${existingCompileCommands}`)
      return existingCompileCommands
    }
    const existingArgsFile = await findGnOutputFile(gnRoot, 'args.gn')
    const generatedOutputDir = existingArgsFile
      ? dirname(existingArgsFile)
      : join(
          gnRoot,
          'out',
          `.orca-code-intelligence-${basename(dirname(buildDir))}-${basename(buildDir)}`
        )
    const relativeOutputDir = relative(gnRoot, generatedOutputDir).replace(/\\/g, '/')
    if (!relativeOutputDir || relativeOutputDir.startsWith('../')) {
      throw new Error('GN output directory resolved outside the project root')
    }
    const commandArgs = ['gen', relativeOutputDir, `--root=${gnRoot}`, '--export-compile-commands']
    const result = await this.runCommand(gnExecutable, commandArgs, gnRoot, environment)
    appendCppSetupLog(
      logs,
      `Configure ${root.memberLabel}`,
      [gnExecutable, ...commandArgs],
      result
    )
    if (result.code !== 0) {
      throw new Error(
        `GN generation failed for ${root.memberLabel}. Generate a GN output directory with the project's required args.gn, then retry.`
      )
    }
    return join(generatedOutputDir, 'compile_commands.json')
  }
}
