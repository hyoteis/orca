import { isAbsolute, resolve } from 'node:path'
import type { Repo } from '../../shared/types'

/** Host path flavor — how supplied-database entries resolve on the execution
 * Host (node path locally, posix over SSH). */
export type CppSetupPathDetection = {
  resolve: (from: string, to: string) => string
  isAbsolute: (path: string) => boolean
}

export const localCppSetupPathDetection: CppSetupPathDetection = {
  resolve,
  isAbsolute
}

/**
 * Execution surface the aggregate C++ pipeline runs against (see CONTEXT.md).
 * The local filesystem and the SSH exec queue are the two adapters; every Host
 * divergence (path flavor, transport errors) lives in an adapter, never in the
 * pipeline. The pipeline calls validateRepoHost before any other method.
 */
export type CppSetupHost = {
  detection: CppSetupPathDetection
  /** Repo→Host gate; a message fails the run before any other method runs. */
  validateRepoHost(repo: Repo, logs: string[]): Promise<string | null>
  /** Stable scope output directory; resolves uname/$HOME remotely. */
  scopeDirectoryFor(repo: Repo): Promise<string>
  /** Batched mtimes for drift probes; null skips the probe round trip. */
  statMtimes(paths: readonly string[]): Promise<number[] | null>
  findSourceFiles(root: string): Promise<string[]>
  findIncludeDirectories(root: string): Promise<string[]>
  readableDirectories(candidates: readonly string[]): Promise<string[]>
  readTextFile(path: string): Promise<string>
  /** Atomic per-Host file write (tmp+rename / stdin+mv). */
  writeTextFile(directory: string, fileName: string, content: string): Promise<void>
  ensureDirectory(directory: string): Promise<void>
}
