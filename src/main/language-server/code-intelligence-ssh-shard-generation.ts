import { posix } from 'node:path'
import type { CodeIntelligenceCppSetupRequest } from '../../shared/code-intelligence-cpp-setup'
import { shellEscape } from '../ssh/ssh-connection-utils'
import {
  appendCppSetupLog,
  type CppSetupCommandRunner,
  type CppSetupToolName
} from './code-intelligence-cpp-setup-tools'
import {
  compilerArguments,
  MAX_SOURCE_FILES
} from './code-intelligence-compilation-database'
import type { CppBuildRoot, CppBuildRootDetection } from './code-intelligence-cmake-root-selection'
import { findGnOutputFile } from './code-intelligence-gn-output'
import {
  buildRemoteFindIncludeDirectoriesCommand,
  buildRemoteFindSourceFilesCommand,
  buildRemoteReadableDirectoriesCommand,
  buildRemoteReadFileCommand,
  type SshSetupExecQueue
} from './code-intelligence-ssh-setup-exec'

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

/** Remote shard generation: BASIC source walks plus cmake/gn configure runs,
 * all serialized through the exec queue (spec §4.2). Configure failures throw
 * and bubble to the run-level atomic failure. */
export async function generateRemoteCppShards(args: {
  queue: SshSetupExecQueue
  run: CppSetupCommandRunner
  detection: CppBuildRootDetection
  workspaceRoot: string
  scopeDirectory: string
  request: CodeIntelligenceCppSetupRequest
  buildRoots: readonly CppBuildRoot[]
  gnRootBySource: ReadonlyMap<string, string | null>
  basicSourceRoots: readonly string[]
  tools: Partial<Record<CppSetupToolName, string>>
  logs: string[]
}): Promise<{ shards: unknown[][]; generationModes: Set<string> }> {
  const { queue, run, workspaceRoot, scopeDirectory, request, logs } = args
  const shards: unknown[][] = []
  const generationModes = new Set<string>()

  if (args.basicSourceRoots.length > 0) {
    // Zero-source members keep the BASIC mode locally (empty shard semantics)
    // even when they contribute no commands of their own.
    generationModes.add('BASIC')
    const sourceFiles: string[] = []
    for (const sourceRoot of args.basicSourceRoots) {
      sourceFiles.push(
        ...parseRemoteListing(await queue.capture(buildRemoteFindSourceFilesCommand(sourceRoot)))
      )
    }
    if (sourceFiles.length > MAX_SOURCE_FILES) {
      throw new Error(`Basic C++ indexing exceeds ${MAX_SOURCE_FILES} source files`)
    }
    if (sourceFiles.length > 0) {
      const discoveredIncludes: string[] = []
      for (const discoveryRoot of new Set([workspaceRoot, ...args.buildRoots.map((r) => r.sourceDir)])) {
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
        ...args.buildRoots.flatMap((root) => [
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
        `\n## Basic C++ indexing\nGenerated minimal commands for ${database.length} source files across: ${args.basicSourceRoots.join(', ')}`
      )
      shards.push(await readRemoteShard(queue, posix.join(basicDirectory, 'compile_commands.json')))
    }
  }

  for (const [index, root] of args.buildRoots.entries()) {
    const buildDir = posix.join(scopeDirectory, `build-${index + 1}`)
    if (root.system === 'cmake') {
      await queue.capture(`rm -rf ${shellEscape(buildDir)} && mkdir -p ${shellEscape(buildDir)}`)
      const commandArgs = [
        '-S',
        root.sourceDir,
        '-B',
        buildDir,
        '-G',
        'Ninja',
        `-DCMAKE_MAKE_PROGRAM=${args.tools.ninja}`,
        '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
        '-DCMAKE_BUILD_TYPE=Debug'
      ]
      const result = await run(args.tools.cmake!, commandArgs, workspaceRoot)
      appendCppSetupLog(logs, `Configure ${root.memberLabel}`, [args.tools.cmake!, ...commandArgs], result)
      if (result.code !== 0) {
        throw new Error(`CMake configuration failed for ${root.memberLabel}`)
      }
      shards.push(await readRemoteShard(queue, posix.join(buildDir, 'compile_commands.json')))
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
      args.detection
    )
    if (existingCompileCommands) {
      logs.push(`\n## Reuse GN compile commands\n${existingCompileCommands}`)
      shards.push(await readRemoteShard(queue, existingCompileCommands))
      generationModes.add('GN')
      continue
    }
    const existingArgsFile = await findGnOutputFile(gnRoot, 'args.gn', args.detection)
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
    const result = await run(args.tools.gn!, commandArgs, gnRoot)
    appendCppSetupLog(logs, `Configure ${root.memberLabel}`, [args.tools.gn!, ...commandArgs], result)
    if (result.code !== 0) {
      throw new Error(
        `GN generation failed for ${root.memberLabel}. Generate a GN output directory with the project's required args.gn, then retry.`
      )
    }
    shards.push(await readRemoteShard(queue, posix.join(generatedOutputDir, 'compile_commands.json')))
    generationModes.add('GN')
  }

  return { shards, generationModes }
}
