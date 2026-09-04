import type { Repo } from '../../shared/types'
import type { CodeIntelligenceCppSetupResult } from '../../shared/code-intelligence-cpp-setup'
import type { CppBuildRootDetection } from './code-intelligence-cmake-root-selection'
import type {
  CppSetupCommandRunner,
  CppSetupToolName,
  CppSetupToolPaths
} from './code-intelligence-cpp-setup-tools'

/**
 * Execution surface the C++ setup pipeline runs against (see CONTEXT.md).
 * The local filesystem and the SSH exec queue are the two adapters; every
 * Host divergence (mtime precision, cache re-checks, transport errors) lives
 * in an adapter, never in the pipeline. The pipeline calls validateRepoHost
 * before any other method.
 */
export type CppSetupHost = {
  detection: CppBuildRootDetection
  runCommand: CppSetupCommandRunner
  /** Repo→Host gate; a message fails the run before any command executes. */
  validateRepoHost(repo: Repo, logs: string[]): Promise<string | null>
  /** Stable scope output directory; resolves uname/$HOME remotely. */
  scopeDirectoryFor(repo: Repo): Promise<string>
  /** Batched mtimes for fingerprint inputs; null skips the cache round trip. */
  statMtimes(paths: readonly string[]): Promise<number[] | null>
  readCachedResult(
    scopeDirectory: string,
    fingerprint: string
  ): Promise<CodeIntelligenceCppSetupResult | null>
  discoverTools(
    requiredTools: readonly CppSetupToolName[],
    workspaceRoot: string
  ): Promise<CppSetupToolPaths>
  /** Installs `missing`; returns the installed tool names in install order. */
  installTools(
    missing: readonly CppSetupToolName[],
    workspaceRoot: string,
    logs: string[]
  ): Promise<string[]>
  /** Configure-time env (MSVC capture locally); the SSH runner ignores it. */
  configureEnvironment(
    cmakeRequired: boolean,
    logs: string[]
  ): Promise<NodeJS.ProcessEnv | undefined>
  ensureDirectory(directory: string): Promise<void>
  /** Fresh build directory for a configure run (rm + mkdir). */
  resetBuildDirectory(buildDirectory: string): Promise<void>
  findSourceFiles(root: string): Promise<string[]>
  findIncludeDirectories(root: string): Promise<string[]>
  readableDirectories(candidates: readonly string[]): Promise<string[]>
  readTextFile(path: string): Promise<string>
  /** Atomic per-Host file write (tmp+rename / stdin+mv). */
  writeTextFile(directory: string, fileName: string, content: string): Promise<void>
  writeCachedResult(
    scopeDirectory: string,
    fingerprint: string,
    result: CodeIntelligenceCppSetupResult
  ): Promise<void>
  /** GN relative output dir; backslash folding is Host-flavor specific. */
  relativeGnOutput(gnRoot: string, outputDirectory: string): string
  /** Maps a thrown error to the user-facing message, appending run logs. */
  describeRunError(error: unknown, logs: string[]): string
}
