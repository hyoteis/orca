import { createHash } from 'node:crypto'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import type { CppBuildRoot } from './code-intelligence-cmake-root-selection'

const CACHE_RESULT_FILE = 'setup-result.json'

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

export async function createCodeIntelligenceSetupCacheKey(args: {
  repoId: string
  roots: readonly string[]
  request: CodeIntelligenceCppSetupRequest
  buildRoots: readonly CppBuildRoot[]
}): Promise<string> {
  const buildInputs = await Promise.all(
    args.buildRoots.map(async (root) => ({
      path: root.sourceDir,
      system: root.system,
      directoryModifiedAt: await modifiedAt(root.sourceDir),
      cmakeModifiedAt: await modifiedAt(join(root.sourceDir, 'CMakeLists.txt')),
      gnModifiedAt: await modifiedAt(join(root.sourceDir, 'BUILD.gn')),
      dotGnModifiedAt: await modifiedAt(join(root.sourceDir, '.gn'))
    }))
  )
  return createHash('sha256')
    .update(
      JSON.stringify({
        repoId: args.repoId,
        roots: args.roots,
        additionalIncludeDirectories: args.request.additionalIncludeDirectories ?? [],
        defines: args.request.defines ?? [],
        cppStandard: args.request.cppStandard ?? 'c++17',
        buildInputs
      })
    )
    .digest('hex')
    .slice(0, 16)
}

export async function readCachedCodeIntelligenceSetupResult(
  outputRoot: string
): Promise<CodeIntelligenceCppSetupResult | null> {
  try {
    await access(join(outputRoot, 'compile_commands.json'), constants.R_OK)
    const parsed = JSON.parse(
      await readFile(join(outputRoot, CACHE_RESULT_FILE), 'utf8')
    ) as CodeIntelligenceCppSetupResult
    if (!parsed.ok || !parsed.clangdExecutable || !parsed.compileCommandsDir) {
      return null
    }
    await access(parsed.clangdExecutable, constants.X_OK)
    return {
      ...parsed,
      message: `Reused cached ${parsed.configurationMode?.toUpperCase() ?? 'C++'} compile commands`
    }
  } catch {
    return null
  }
}

export async function writeCachedCodeIntelligenceSetupResult(
  outputRoot: string,
  result: CodeIntelligenceCppSetupResult
): Promise<void> {
  await writeFile(join(outputRoot, CACHE_RESULT_FILE), JSON.stringify(result, null, 2))
}
