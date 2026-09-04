import type { Store } from '../persistence'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import { normalizeScopeMemberPath } from '../../shared/code-intelligence-scope'
import {
  NO_COMPILE_COMMANDS_MESSAGE,
  type CppSetupToolName
} from './code-intelligence-cpp-setup-tools'
import type { CppBuildRoot } from './code-intelligence-cmake-root-selection'
import { classifyCppBuildRoots } from './code-intelligence-build-root-classification'
import { mergeCompilationDatabaseShards } from './code-intelligence-compilation-database'
import {
  codeIntelligenceSetupFingerprintDigest,
  type CppSetupFingerprintBuildInput
} from './code-intelligence-setup-cache'
import type { CppSetupHost } from './code-intelligence-cpp-setup-host'
import { generateCppShards } from './code-intelligence-cpp-setup-generation'

const BASIC_WARNING =
  'Basic indexing uses inferred include directories and may miss SDK headers, generated files, or build macros.'

async function setupFingerprint(
  host: CppSetupHost,
  repoId: string,
  roots: readonly string[],
  request: CodeIntelligenceCppSetupRequest,
  buildRoots: readonly CppBuildRoot[]
): Promise<string | null> {
  const detection = host.detection
  const paths = buildRoots.flatMap((root) => [
    root.sourceDir,
    detection.join(root.sourceDir, 'CMakeLists.txt'),
    detection.join(root.sourceDir, 'BUILD.gn'),
    detection.join(root.sourceDir, '.gn')
  ])
  const mtimes = await host.statMtimes(paths)
  if (!mtimes) {
    return null
  }
  const buildInputs: CppSetupFingerprintBuildInput[] = buildRoots.map((root, index) => ({
    path: root.sourceDir,
    system: root.system,
    directoryModifiedAt: mtimes[index * 4]!,
    cmakeModifiedAt: mtimes[index * 4 + 1]!,
    gnModifiedAt: mtimes[index * 4 + 2]!,
    dotGnModifiedAt: mtimes[index * 4 + 3]!
  }))
  return codeIntelligenceSetupFingerprintDigest({ repoId, roots, request, buildInputs })
}

/** The single C++ setup step sequence (see CONTEXT.md); one implementation
 * for every Host, all divergence behind the CppSetupHost adapter. */
export async function runCppSetupPipeline(
  store: Store,
  host: CppSetupHost,
  request: CodeIntelligenceCppSetupRequest
): Promise<CodeIntelligenceCppSetupResult> {
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
    const repo = store.getRepo(request.repoId)
    if (!repo) {
      return fail('Project is no longer available')
    }
    const gateError = await host.validateRepoHost(repo, logs)
    if (gateError) {
      return fail(gateError)
    }
    // Dual-form members: workspace-relative and host-absolute strings coexist.
    roots = [...new Set(request.relativeRoots.map(normalizeScopeMemberPath))]
    if (roots.length === 0) {
      return fail('Select at least one C++ build directory')
    }
    const workspaceRoot = host.detection.resolve(repo.path)
    const scopeDirectory = await host.scopeDirectoryFor(repo)
    const { buildRoots, gnRootBySource, basicSourceRoots } = await classifyCppBuildRoots(
      workspaceRoot,
      roots,
      host.detection
    )
    const fingerprint = await setupFingerprint(host, repo.id, roots, request, buildRoots)
    if (fingerprint) {
      const cached = await host.readCachedResult(scopeDirectory, fingerprint)
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
    let tools = await host.discoverTools(requiredTools, workspaceRoot)
    const missing = requiredTools.filter((tool) => !tools[tool])
    if (missing.length > 0) {
      if (!request.installMissingTools) {
        return fail(`Missing tools: ${missing.join(', ')}`)
      }
      installedTools = await host.installTools(missing, workspaceRoot, logs)
      tools = await host.discoverTools(requiredTools, workspaceRoot)
      const stillMissing = requiredTools.filter((tool) => !tools[tool])
      if (stillMissing.length > 0) {
        return fail(`Installed tools were not found: ${stillMissing.join(', ')}`)
      }
    }
    const commandEnvironment = await host.configureEnvironment(
      buildRoots.some((root) => root.system === 'cmake'),
      logs
    )
    await host.ensureDirectory(scopeDirectory)
    const { shards, generationModes } = await generateCppShards(host, {
      workspaceRoot,
      scopeDirectory,
      request,
      buildRoots,
      gnRootBySource,
      basicSourceRoots,
      tools,
      commandEnvironment,
      logs
    })
    // Shards are read back from the Host before this single-source merge;
    // an empty merge fails all-zero and never clobbers the live merged CDB.
    const merged = mergeCompilationDatabaseShards(shards)
    if (merged.length === 0) {
      return fail(NO_COMPILE_COMMANDS_MESSAGE)
    }
    await host.writeTextFile(
      scopeDirectory,
      'compile_commands.json',
      JSON.stringify(merged, null, 2)
    )
    logs.push(`Merged ${merged.length} compile commands into ${scopeDirectory}`)
    const systems = [...generationModes].join(' + ')
    const configurationMode =
      generationModes.size === 1
        ? ([...generationModes][0]!.toLowerCase() as 'cmake' | 'gn' | 'basic')
        : 'mixed'
    const warnings = generationModes.has('BASIC') ? [BASIC_WARNING] : []
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
      await host.writeCachedResult(scopeDirectory, fingerprint, result)
    }
    return result
  } catch (error) {
    return fail(host.describeRunError(error, logs))
  }
}
