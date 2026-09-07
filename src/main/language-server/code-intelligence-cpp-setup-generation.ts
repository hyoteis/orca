import type { CodeIntelligenceCppSetupRequest } from '../../shared/code-intelligence-cpp-setup'
import { appendCppSetupLog, type CppSetupToolName } from './code-intelligence-cpp-setup-tools'
import type { CppBuildRoot } from './code-intelligence-cmake-root-selection'
import { findGnOutputFile } from './code-intelligence-gn-output'
import {
  compilerArguments,
  MAX_SOURCE_FILES
} from './code-intelligence-compilation-database'
import type { CppSetupHost } from './code-intelligence-cpp-setup-host'

type CppShardGenerationArgs = {
  workspaceRoot: string
  scopeDirectory: string
  request: CodeIntelligenceCppSetupRequest
  buildRoots: readonly CppBuildRoot[]
  gnRootBySource: ReadonlyMap<string, string | null>
  basicSourceRoots: readonly string[]
  tools: Partial<Record<CppSetupToolName, string>>
  commandEnvironment: NodeJS.ProcessEnv | undefined
  logs: string[]
}

/** Private seam of the setup pipeline (max-lines split, not a public interface):
 * shard generation over Host primitives. Configure failures throw and bubble
 * to the pipeline's atomic run-level failure — except GN members, which degrade
 * to inferred commands so one unbuildable member cannot blank the whole setup. */
export async function generateCppShards(
  host: CppSetupHost,
  args: CppShardGenerationArgs
): Promise<{ shards: unknown[][]; generationModes: Set<string>; warnings: string[] }> {
  const detection = host.detection
  const shards: unknown[][] = []
  const generationModes = new Set<string>()
  const warnings: string[] = []

  if (args.basicSourceRoots.length > 0) {
    // Zero-source members keep the BASIC mode (empty shard semantics) even
    // when they contribute no commands of their own.
    generationModes.add('BASIC')
    const database = await inferredCompileCommands(host, args, args.basicSourceRoots)
    if (database.length > 0) {
      const basicDirectory = detection.join(args.scopeDirectory, 'basic')
      await host.ensureDirectory(basicDirectory)
      await host.writeTextFile(
        basicDirectory,
        'compile_commands.json',
        JSON.stringify(database, null, 2)
      )
      args.logs.push(
        `\n## Basic C++ indexing\nNo GN dotfile was found; generated minimal commands for ${database.length} source files across: ${args.basicSourceRoots.join(', ')}`
      )
      shards.push(
        JSON.parse(await host.readTextFile(detection.join(basicDirectory, 'compile_commands.json')))
      )
    }
  }

  for (const [index, root] of args.buildRoots.entries()) {
    const buildDir = detection.join(args.scopeDirectory, `build-${index + 1}`)
    if (root.system === 'cmake') {
      await host.resetBuildDirectory(buildDir)
      const commandArgs = [
        '-S',
        root.sourceDir,
        '-B',
        buildDir,
        '-G',
        'Ninja',
        `-DCMAKE_MAKE_PROGRAM=${args.tools.ninja}`,
        '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        '-DCMAKE_BUILD_TYPE=Debug',
        ...(args.request.cmakeDefines ?? [])
          .map((define) => define.trim())
          .filter(Boolean)
          .map((define) => `-D${define}`)
      ]
      const result = await host.runCommand(
        args.tools.cmake!,
        commandArgs,
        args.workspaceRoot,
        args.commandEnvironment
      )
      appendCppSetupLog(
        args.logs,
        `Configure ${root.memberLabel}`,
        [args.tools.cmake!, ...commandArgs],
        result
      )
      if (result.code !== 0) {
        throw new Error(`CMake configuration failed for ${root.memberLabel}`)
      }
      shards.push(
        JSON.parse(await host.readTextFile(detection.join(buildDir, 'compile_commands.json')))
      )
      generationModes.add('CMAKE')
      continue
    }
    const gnRoot = args.gnRootBySource.get(root.sourceDir)
    if (!gnRoot) {
      continue
    }
    const existingCompileCommands = await findGnOutputFile(
      gnRoot,
      'compile_commands.json',
      detection
    )
    if (existingCompileCommands) {
      args.logs.push(`\n## Reuse GN compile commands\n${existingCompileCommands}`)
      shards.push(JSON.parse(await host.readTextFile(existingCompileCommands)))
      generationModes.add('GN')
      continue
    }
    const existingArgsFile = await findGnOutputFile(gnRoot, 'args.gn', detection)
    const generatedOutputDir = existingArgsFile
      ? detection.dirname(existingArgsFile)
      : detection.join(
          gnRoot,
          'out',
          `.orca-code-intelligence-${detection.basename(detection.dirname(buildDir))}-${detection.basename(buildDir)}`
        )
    const relativeOutputDir = host.relativeGnOutput(gnRoot, generatedOutputDir)
    if (!relativeOutputDir || relativeOutputDir.startsWith('../')) {
      throw new Error('GN output directory resolved outside the project root')
    }
    const commandArgs = ['gen', relativeOutputDir, `--root=${gnRoot}`, '--export-compile-commands']
    const result = await host.runCommand(
      args.tools.gn!,
      commandArgs,
      gnRoot,
      args.commandEnvironment
    )
    appendCppSetupLog(
      args.logs,
      `Configure ${root.memberLabel}`,
      [args.tools.gn!, ...commandArgs],
      result
    )
    if (result.code !== 0) {
      // Root .gn files that need the project's real args.gn (e.g. OHOS) can
      // never be configured standalone; degrade, don't fail the whole run.
      const database = await inferredCompileCommands(host, args, [root.sourceDir])
      generationModes.add('BASIC')
      warnings.push(
        `GN generation failed for ${root.memberLabel}; indexed with inferred include directories. Generate a GN output directory with the project's required args.gn, then re-run setup.`
      )
      if (database.length > 0) {
        const fallbackDirectory = detection.join(args.scopeDirectory, `basic-${index + 1}`)
        await host.ensureDirectory(fallbackDirectory)
        await host.writeTextFile(
          fallbackDirectory,
          'compile_commands.json',
          JSON.stringify(database, null, 2)
        )
        args.logs.push(
          `\n## Basic C++ indexing\nGN generation failed for ${root.memberLabel}; generated minimal commands for ${database.length} source files across: ${root.sourceDir}`
        )
        shards.push(
          JSON.parse(
            await host.readTextFile(detection.join(fallbackDirectory, 'compile_commands.json'))
          )
        )
      }
      continue
    }
    shards.push(
      JSON.parse(
        await host.readTextFile(detection.join(generatedOutputDir, 'compile_commands.json'))
      )
    )
    generationModes.add('GN')
  }

  return { shards, generationModes, warnings }
}

async function inferredCompileCommands(
  host: CppSetupHost,
  args: CppShardGenerationArgs,
  sourceRoots: readonly string[]
): Promise<{ directory: string; file: string; arguments: string[] }[]> {
  const detection = host.detection
  const sourceFiles: string[] = []
  for (const sourceRoot of sourceRoots) {
    sourceFiles.push(...(await host.findSourceFiles(sourceRoot)))
  }
  if (sourceFiles.length > MAX_SOURCE_FILES) {
    throw new Error(`Basic C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
  }
  if (sourceFiles.length === 0) {
    return []
  }
  const discoveredIncludes: string[] = []
  for (const discoveryRoot of new Set([
    args.workspaceRoot,
    ...args.buildRoots.map((root) => root.sourceDir)
  ])) {
    discoveredIncludes.push(...(await host.findIncludeDirectories(discoveryRoot)))
  }
  const additionalIncludes = (args.request.additionalIncludeDirectories ?? []).map((path) =>
    detection.isAbsolute(path)
      ? detection.resolve(path)
      : detection.resolve(args.workspaceRoot, path)
  )
  const includeCandidates = [
    args.workspaceRoot,
    ...additionalIncludes,
    ...discoveredIncludes,
    ...args.buildRoots.flatMap((root) => [
      root.sourceDir,
      detection.join(root.sourceDir, 'api'),
      detection.join(root.sourceDir, 'include'),
      detection.join(root.sourceDir, 'src')
    ])
  ]
  const includeDirectories = await host.readableDirectories([...new Set(includeCandidates)])
  const defines = (args.request.defines ?? []).map((define) => define.trim()).filter(Boolean)
  return sourceFiles.map((file) => ({
    directory: args.workspaceRoot,
    file,
    arguments: compilerArguments(
      file,
      includeDirectories,
      defines,
      args.request.cppStandard ?? 'c++17'
    )
  }))
}
