import { createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'

// Structural cache-root children; everything else is a legacy directory
// (pre-#139 hash dirs and the deleted cached-tool cache).
const RETAINED_CPP_CACHE_DIRECTORIES = new Set(['scopes'])

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
