import { createHash } from 'node:crypto'
import { access, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, posix } from 'node:path'
import type {
  CodeIntelligenceCppSetupRequest,
  CodeIntelligenceCppSetupResult
} from '../../shared/code-intelligence-cpp-setup'
import type { CppBuildRoot } from './code-intelligence-cmake-root-selection'

export const SETUP_MANIFEST_FILE = 'setup-manifest.json'
// Structural cache-root children; everything else is a legacy hash directory.
const RETAINED_CPP_CACHE_DIRECTORIES = new Set(['tools', 'scopes'])

async function modifiedAt(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

export function cppScopeDirectoryName(scopeId: string): string {
  return createHash('sha256').update(scopeId).digest('hex').slice(0, 16)
}

export function cppScopeDirectoryPath(cacheRoot: string, scopeId: string): string {
  return join(cacheRoot, 'scopes', cppScopeDirectoryName(scopeId))
}

/** Remote scope layout mirror (spec §2): ~/.orca/code-intelligence/cpp/scopes/<dirName>. */
export function remoteCppScopesRootPath(home: string): string {
  return posix.join(home, '.orca', 'code-intelligence', 'cpp', 'scopes')
}

export function remoteCppScopeDirectoryPath(home: string, scopeId: string): string {
  // posix.join: the remote layout is POSIX regardless of the local platform.
  return posix.join(remoteCppScopesRootPath(home), cppScopeDirectoryName(scopeId))
}

export async function createCodeIntelligenceSetupFingerprint(args: {
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
  return codeIntelligenceSetupFingerprintDigest({ ...args, buildInputs })
}

export type CppSetupFingerprintBuildInput = {
  path: string
  system: CppBuildRoot['system']
  directoryModifiedAt: number
  cmakeModifiedAt: number
  gnModifiedAt: number
  dotGnModifiedAt: number
}

/** Pure fingerprint core shared by the local (fs stat) and SSH (remote stat) flows. */
export function codeIntelligenceSetupFingerprintDigest(args: {
  repoId: string
  roots: readonly string[]
  request: CodeIntelligenceCppSetupRequest
  buildInputs: readonly CppSetupFingerprintBuildInput[]
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repoId: args.repoId,
        roots: args.roots,
        additionalIncludeDirectories: args.request.additionalIncludeDirectories ?? [],
        defines: args.request.defines ?? [],
        cppStandard: args.request.cppStandard ?? 'c++17',
        buildInputs: args.buildInputs
      })
    )
    .digest('hex')
}

export function parseCachedCodeIntelligenceSetupResult(
  manifestText: string,
  fingerprint: string
): CodeIntelligenceCppSetupResult | null {
  try {
    const manifest = JSON.parse(manifestText) as {
      fingerprint?: unknown
      result?: CodeIntelligenceCppSetupResult
    }
    if (manifest.fingerprint !== fingerprint || !manifest.result?.ok) {
      return null
    }
    const cached = manifest.result
    if (!cached.clangdExecutable || !cached.compileCommandsDir) {
      return null
    }
    return {
      ...cached,
      message: `Reused cached ${cached.configurationMode?.toUpperCase() ?? 'C++'} compile commands`
    }
  } catch {
    return null
  }
}

export async function readCachedCodeIntelligenceSetupResult(
  scopeDirectory: string,
  fingerprint: string
): Promise<CodeIntelligenceCppSetupResult | null> {
  try {
    const cached = parseCachedCodeIntelligenceSetupResult(
      await readFile(join(scopeDirectory, SETUP_MANIFEST_FILE), 'utf8'),
      fingerprint
    )
    if (!cached) {
      return null
    }
    await access(join(scopeDirectory, 'compile_commands.json'), constants.R_OK)
    // parseCached guarantees this is set.
    await access(cached.clangdExecutable!, constants.X_OK)
    return cached
  } catch {
    return null
  }
}

export async function writeCachedCodeIntelligenceSetupResult(
  scopeDirectory: string,
  fingerprint: string,
  result: CodeIntelligenceCppSetupResult
): Promise<void> {
  await writeFile(
    join(scopeDirectory, SETUP_MANIFEST_FILE),
    JSON.stringify({ fingerprint, result }, null, 2)
  )
}

export async function sweepOrphanCppScopeDirectories(
  cacheRoot: string,
  liveScopeIds: readonly string[]
): Promise<void> {
  try {
    const retained = new Set(liveScopeIds.map(cppScopeDirectoryName))
    const entries = await readdir(cacheRoot, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !RETAINED_CPP_CACHE_DIRECTORIES.has(entry.name))
        .map((entry) => rm(join(cacheRoot, entry.name), { recursive: true, force: true }))
    )
    // Scope-level sweep (spec §6): directories under scopes/ owned by no live
    // scope are stale caches — e.g. removed while the host was offline.
    const scopesRoot = join(cacheRoot, 'scopes')
    const scopeEntries = await readdir(scopesRoot, { withFileTypes: true })
    await Promise.all(
      scopeEntries
        .filter((entry) => entry.isDirectory() && !retained.has(entry.name))
        .map((entry) => rm(join(scopesRoot, entry.name), { recursive: true, force: true }))
    )
  } catch {
    // Best-effort startup sweep; a missing or unreadable cache root is fine.
  }
}
